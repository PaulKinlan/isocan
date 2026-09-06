#!/usr/bin/env bash
#
# STAGE B (continued) — the content origin: a second registrable domain on the
# SAME load balancer and the SAME Cloud Run service.
#
# CREATES   a Google-managed SSL certificate for ${CONTENT_DOMAIN}, attached to
#           the existing HTTPS proxy beside the app's; a host rule on the
#           existing URL map sending that Host to the existing backend; and an
#           explicit cache-key policy on that backend.
#
# COSTS     nothing new that bills by the hour. No forwarding rule, no address,
#           no service: the $18/month load balancer is already there and this
#           adds a name to it. The managed certificate is free. Per use, the
#           content origin is where CDN egress finally happens — signed reads
#           are publicly cacheable for their TTL, which is the point.
#
# ASSUMES   80-load-balancer.sh finished, and CONTENT_DOMAIN is set (it is not
#           on dev — see config.sh). Running it on a home with no content
#           domain does nothing and says so.
#
# UNDO      remove the host rule (the app keeps answering on its own domain),
#           then detach and delete the certificate. Deploying the service
#           WITHOUT ISOCAN_CONTENT_HOST is the real rollback and needs none of
#           this: the daemon stops advertising the origin, frames go back to
#           the app origin, and nothing in the front door has to change first.
#
# ═══ WHY THIS EXISTS AT ALL ═══
#
# Item content — the HTML an agent wrote and dropped on a canvas — is served
# from an origin that owns nothing, so that granting it `allow-same-origin`
# (which it needs to have storage) hands it nothing of ours. A subdomain will
# not do, because cookies scope to parent domains. So: a second registrable
# domain, the `githubusercontent.com` pattern.
#   docs/projects/atlas/content-origin.md         — why
#   docs/projects/atlas/content-origin-plan.md    — in what order
#   docs/projects/multiuser/content-read-auth.md  — how a cookieless origin
#                                                   knows who may read a
#                                                   private canvas's bytes
#
# ═══ THE ORDERING, SAME TRAP AS THE APP'S CERTIFICATE ═══
#
#   1. point ${CONTENT_DOMAIN}'s A record at the load balancer's IP  ← YOU,
#      at the registrar. The same IP the app domain uses; this script prints
#      it. (Done for isocan.store at Namecheap on 5 September 2026.)
#   2. run this
#   3. wait for the certificate to leave PROVISIONING (81-cert-status.sh, with
#      ISOCAN_CERT_NAME set to the content cert, polls it)
#   4. deploy the service so the daemon receives ISOCAN_CONTENT_HOST
#      (70-cloud-run.sh) — until then the domain answers with the app, which
#      is harmless and is what the 5 September redirect was standing in for.
#
# A certificate created BEFORE the A record resolves records FAILED_NOT_VISIBLE
# and cannot be revalidated in place — that is the whole story behind
# `isocan-cert-2`. Do step 1 first.

source "$(dirname -- "${BASH_SOURCE[0]}")/lib/common.sh"
preflight
require_project

HTTPS_PROXY_NAME="${SERVICE}-https-proxy"
CONTENT_MATCHER="content"

if [ -z "${CONTENT_DOMAIN}" ]; then
  note "no ISOCAN_CONTENT_DOMAIN for this home — nothing to do."
  note "the app serves item content from its own origin, exactly as it always has."
  exit 0
fi

exists gcloud compute url-maps describe "${URLMAP_NAME}" --global --project="${PROJECT_ID}" \
  || die "no URL map ${URLMAP_NAME} — finish 80-load-balancer.sh first"

LB_IP="$(gcloud compute addresses describe "${LB_IP_NAME}" --global \
  --project="${PROJECT_ID}" --format='value(address)')"
note "${CONTENT_DOMAIN} must have an A record pointing at ${LB_IP}"

# --------------------------------------------------------- 1. the certificate

step "managed certificate for ${CONTENT_DOMAIN}"
if exists gcloud compute ssl-certificates describe "${CONTENT_CERT_NAME}" --global --project="${PROJECT_ID}"; then
  have "${CONTENT_CERT_NAME}"
else
  gcloud compute ssl-certificates create "${CONTENT_CERT_NAME}" \
    --project="${PROJECT_ID}" --global \
    --domains="${CONTENT_DOMAIN}" >/dev/null
  made "${CONTENT_CERT_NAME} for ${CONTENT_DOMAIN} (state: PROVISIONING)"
fi

# A target proxy carries a LIST of certificates and picks by SNI, so the app's
# and the content origin's live side by side on one proxy — one frontend, two
# names. `--ssl-certificates` REPLACES the list, so the app's certificate has to
# be named again here or it would be dropped and every request to the app
# domain would fail its handshake.
step "certificate attached to ${HTTPS_PROXY_NAME}"
ATTACHED="$(gcloud compute target-https-proxies describe "${HTTPS_PROXY_NAME}" \
  --global --project="${PROJECT_ID}" --format='value(sslCertificates)')"
if printf '%s' "${ATTACHED}" | grep -q "/${CONTENT_CERT_NAME}\$\|/${CONTENT_CERT_NAME},"; then
  have "${CONTENT_CERT_NAME} on ${HTTPS_PROXY_NAME}"
else
  gcloud compute target-https-proxies update "${HTTPS_PROXY_NAME}" \
    --project="${PROJECT_ID}" --global \
    --ssl-certificates="${CERT_NAME},${CONTENT_CERT_NAME}" >/dev/null
  made "${CERT_NAME} + ${CONTENT_CERT_NAME} on ${HTTPS_PROXY_NAME}"
fi

# ------------------------------------------------------------ 2. the host rule

# **This is the flip.** Until now ${CONTENT_DOMAIN} has been a 301 to the app
# domain — a parked name, so that a person who typed it landed somewhere real
# while the daemon could not yet tell the two Hosts apart. Now the same host
# rule sends it to the same backend the app uses, and the DAEMON does the
# telling apart: a request bearing this Host gets blob bytes or a 404, because
# `ISOCAN_CONTENT_HOST` turns on the content role's refusal of everything else.
#
# One backend and not two, deliberately. A second backend service would be a
# second place to configure CDN, timeouts and health, kept in sync by nobody —
# and there is nothing to configure differently: the SAME container answers,
# and which origin a request arrived on is a header it reads.
step "host rule ${CONTENT_DOMAIN} -> ${BACKEND_NAME}"
MAP_YAML="$(mktemp)"
gcloud compute url-maps describe "${URLMAP_NAME}" --global \
  --project="${PROJECT_ID}" --format=yaml >"${MAP_YAML}"
if grep -q "defaultService.*${BACKEND_NAME}" "${MAP_YAML}" && grep -q "name: ${CONTENT_MATCHER}" "${MAP_YAML}"; then
  have "${CONTENT_DOMAIN} -> ${BACKEND_NAME}"
else
  # `add-path-matcher` replaces a matcher of the same name, so this is
  # idempotent AND is what turns the 5 September redirect into a route.
  gcloud compute url-maps add-path-matcher "${URLMAP_NAME}" \
    --project="${PROJECT_ID}" --global \
    --path-matcher-name="${CONTENT_MATCHER}" \
    --default-service="${BACKEND_NAME}" \
    --new-hosts="${CONTENT_DOMAIN}" \
    --existing-host="${CONTENT_DOMAIN}" >/dev/null 2>&1 \
  || gcloud compute url-maps add-path-matcher "${URLMAP_NAME}" \
    --project="${PROJECT_ID}" --global \
    --path-matcher-name="${CONTENT_MATCHER}" \
    --default-service="${BACKEND_NAME}" \
    --new-hosts="${CONTENT_DOMAIN}" >/dev/null
  made "${CONTENT_DOMAIN} -> ${BACKEND_NAME} (was: 301 to ${DOMAIN})"
fi
rm -f "${MAP_YAML}"

# ------------------------------------------------------- 3. the cache key

# **The one line that makes signed URLs safe to cache at the edge, said out
# loud rather than inherited.**
#
# A verified signed read is served `Cache-Control: public, max-age=<what is
# left of its TTL>` — the URL is the credential and it expires, so a shared
# copy cannot outlive the permission. That reasoning holds only if the cache
# key INCLUDES THE QUERY STRING, which is where the signature is. A cache that
# dropped it would serve a signed response to a caller that presented none:
# every private canvas on this home, readable by anyone who knows a hash.
#
# Cloud CDN's default already includes the query string. It is set explicitly
# anyway, because "the default is currently what we need" is not a control, and
# because a future `--cache-key-include-query-string=false` typed by somebody
# optimizing hit rates would be a silent, total authorization bypass.
step "cache key includes the query string"
gcloud compute backend-services update "${BACKEND_NAME}" \
  --project="${PROJECT_ID}" --global \
  --cache-key-include-query-string >/dev/null
made "${BACKEND_NAME}: signature is part of the cache key"

step "done"
note "next: 81-cert-status.sh (with ISOCAN_CERT_NAME=${CONTENT_CERT_NAME}) until the cert is ACTIVE,"
note "then re-run 70-cloud-run.sh so the daemon receives ISOCAN_CONTENT_HOST=${CONTENT_DOMAIN}."
note "until that deploy, ${CONTENT_DOMAIN} serves the app — harmless, and the same"
note "thing the parked redirect was doing."
