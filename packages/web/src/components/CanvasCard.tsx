import { useEffect, useState } from "react";
import type { CanvasContents, Item } from "@isocan/core";
import { groupAncestors, isArea, isGroupItem, isCanvasItem, automaticCanvasTarget, sourceOf, itemKind } from "@isocan/core";
import { authoritativeHome, sourceSnapshot, sourcePresence, sourcePicture } from "../lib/personal.ts";
import { useCanvasTail } from "../lib/canvastail.ts";
import { canDeepen, MAX_MINIATURE_DEPTH, NESTED_MOST_ITEMS, nestedTarget } from "../lib/canvasdepth.ts";
import { CanvasPreviewBoundary } from "./CanvasPreviewBoundary.tsx";
import { useOnScreen } from "../lib/onscreen.ts";
import { everyWhileVisible } from "../lib/whilevisible.ts";

/**
 * **A canvas, drawn small and live** (`docs/projects/inception/design.md`).
 *
 * The other canvas's picture, laid out as a place: every item as a block at
 * its position, images as themselves, text as its words, sheets as their
 * washes — scaled to fit, the way the minimap fits a canvas into its corner.
 * You can tell a busy canvas from an empty one and a board from a pile at a
 * glance.
 *
 * **A room member, not a poller** (isocan-wq6.6). When the canvas's home is
 * this origin, the card dials the canvas's room (`useCanvasTail`) and every
 * mutation arrives as it lands — a rename on the other canvas reaches the
 * strip in one broadcast, not on the next half-minute pull, and N cards on
 * a wall cost N sockets rather than N pollers reading snapshots forever.
 * The socket follows the tab: hidden means closed, visible again means a
 * fresh dial. A card whose home is elsewhere keeps the thirty-second pull —
 * its room is not here to dial.
 *
 * **Exactly one extra level** (`docs/research/2026-09-07-semantic-zoom.md`,
 * upstream #203 / isocan-wq6.5). Inside the picture, a nested canvas block
 * deepens into the referenced canvas's OWN picture at a fixed budget (<= 40
 * items, only while on screen, only when the drawn box is big enough to
 * read) — so a wall of canvases shows places inside places instead of forty
 * grey marks. Past that one level, or when the box is small, or when the
 * target would close a cycle, a canvas inside the picture is a plain block
 * with its title: a canvas that contains itself, or two that contain each
 * other, is a card and not a recursion.
 *
 * **Never a blank rectangle.** A door that refuses — somebody not admitted
 * to the other canvas — or a home that cannot be read right now says so in
 * words on the card, with the ↗ still there; the site item's first lesson
 * was that a blank frame with no explanation reads as a bug. And while the
 * home is merely away, the last picture stays on screen under the redial.
 */
const PULL_MS = 30_000;
/** How many items the picture draws before it stops: enough for any real
 *  canvas to read as itself, few enough that a pile of a thousand does not
 *  cost a thousand nodes in a card. */
const MOST_ITEMS = 120;

/** Direct card consumers share the same gate as every VersionContent face. */
export function CanvasCard(props: Parameters<typeof OrdinaryCanvasCard>[0]) {
  return <CanvasPreviewBoundary key={`${props.canvasId}:${props.source}`} canvasId={props.canvasId} source={props.source ?? null} destinationCanvasId={props.destinationCanvasId}><OrdinaryCanvasCard {...props} /></CanvasPreviewBoundary>;
}

function OrdinaryCanvasCard({
  canvasId,
  destinationCanvasId,
  width,
  height,
  picture = null,
  source = null,
}: {
  canvasId: string;
  destinationCanvasId: string;
  width: number;
  height: number;
  /** A screenshot version of this item, when one was taken — the picture
   *  that survives a pull the door refuses. Never preferred over live. */
  picture?: string | null;
  /** The address the item points at: a canvas at another home cannot be
   *  pulled from this one (phase 4), and the card says so rather than
   *  asking a door that will not answer. */
  source?: string | null;
}) {
  const elsewhere = (() => {
    if (!source) return null;
    try {
      const origin = new URL(source).origin;
      return origin === window.location.origin ? null : origin;
    } catch {
      return null;
    }
  })();
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "ready"; title: string; canvas: CanvasContents; here: number; home: string }
    | { kind: "refused"; why: string }
  >(elsewhere ? { kind: "refused", why: `Lives at ${elsewhere.replace(/^https?:\/\//, "")} — open it there.` } : { kind: "loading" });

  // The first pull discovers the canvas's home (and paints the picture
  // before the room's hello lands). Once the home turns out to be HERE, the
  // tail takes over and the poll stops; a canvas housed elsewhere keeps the
  // pull, because its room is not this daemon's to dial.
  const homeIsLocal = state.kind === "ready" && state.home === window.location.origin;
  const tail = useCanvasTail(canvasId, homeIsLocal);
  const [polling, setPolling] = useState(true);
  useEffect(() => {
    if (homeIsLocal) setPolling(false);
  }, [homeIsLocal]);

  useEffect(() => {
    if (elsewhere || !polling) return;
    let live = true;
    const controller = new AbortController();
    const pull = async () => {
      try {
        const home = await authoritativeHome(destinationCanvasId, controller.signal);
        const [snapshot, presence] = await Promise.all([
          sourceSnapshot({ canvasId, expectedHome: home }, controller.signal),
          home === window.location.origin ? sourcePresence(home, controller.signal).catch(() => ({ where: [] })) : Promise.resolve({ where: [] }),
        ]);
        if (!live) return;
        const here = new Set(presence.where.filter((row) => row.canvasId === canvasId).map((row) => row.actor.id)).size;
        setState({ kind: "ready", title: snapshot.project.title, canvas: snapshot.canvas, here, home });
      } catch (err) {
        if (!live) return;
        // A refusal at the door is the common case and has a plain meaning;
        // anything else is said as what it is.
        const status = (err as { status?: number }).status;
        setState({
          kind: "refused",
          why:
            status === 401 || status === 403
              ? "You are not admitted to this canvas — open it to ask at its door."
              : "This canvas could not be read right now.",
        });
      }
    };
    const stop = everyWhileVisible(() => void pull(), PULL_MS);
    return () => {
      live = false;
      controller.abort();
      stop();
    };
  }, [canvasId, destinationCanvasId, elsewhere, polling]);

  // Refused at the door, by the room (the tail) or by the pull — the same
  // two sentences either way, and the screenshot when there is one. Never a
  // blank rectangle.
  const refusedWhy = tail.kind === "refused" ? tail.why : state.kind === "refused" ? state.why : null;
  if (refusedWhy !== null) {
    return (
      <div className="canvas-embed">
        {picture && <img className="canvas-embed-picture" src={picture} alt="" />}
        <div className="canvas-embed-note">{refusedWhy}</div>
      </div>
    );
  }
  const ready =
    tail.kind === "live"
      ? { title: tail.state.project.title, canvas: tail.state.canvas, here: tail.here }
      : state.kind === "ready"
        ? { title: state.title, canvas: state.canvas, here: state.here }
        : null;
  if (ready === null) return <div className="canvas-embed canvas-embed-note">Looking…</div>;

  const home = homeIsLocal ? window.location.origin : state.kind === "ready" ? state.home : window.location.origin;
  const items = Object.values(ready.canvas.items);
  const count = items.filter((one) => !isArea(one) && !isGroupItem(one)).length;
  return (
    <div className="canvas-embed">
      <div className="canvas-embed-head">
        <span className="canvas-embed-title">{ready.title}</span>
        <span className="canvas-embed-meta">
          {count} item{count === 1 ? "" : "s"}
          {ready.here > 0 ? ` · ${ready.here} here` : ""}
        </span>
      </div>
      <Miniature home={home} canvasId={canvasId} canvas={ready.canvas} items={items} width={width} height={Math.max(0, height - 40)} />
    </div>
  );
}

/**
 * The picture: every item as a block at its place, fitted into the box. Areas
 * first so their washes sit under what is on them, images as themselves,
 * text and everything else as a block in the kind's colour with its title
 * when there is room to read it.
 */
function Miniature({ canvasId, home, canvas, items, width, height, depth = 1, ancestors = new Set([canvasId]) }: { home: string; canvasId: string; canvas: CanvasContents; items: Item[]; width: number; height: number; depth?: number; ancestors?: Set<string> }) {
  if (items.length === 0) return <div className="canvas-embed-note">Nothing on it yet.</div>;
  const minX = Math.min(...items.map((one) => one.x));
  const minY = Math.min(...items.map((one) => one.y));
  const maxX = Math.max(...items.map((one) => one.x + one.width));
  const maxY = Math.max(...items.map((one) => one.y + one.height));
  // A depth-2 picture lives inside a block a fraction of the card's size, so
  // the level-1 margin would eat the picture; a sliver is enough there.
  const pad = depth >= MAX_MINIATURE_DEPTH ? 4 : 16;
  const scale = Math.min((width - pad * 2) / Math.max(1, maxX - minX), (height - pad * 2) / Math.max(1, maxY - minY));
  const offsetX = pad + ((width - pad * 2) - (maxX - minX) * scale) / 2;
  const offsetY = pad + ((height - pad * 2) - (maxY - minY) * scale) / 2;
  const limit = depth >= MAX_MINIATURE_DEPTH ? NESTED_MOST_ITEMS : MOST_ITEMS;
  const ordered = [...items].sort((a, b) => Number(isArea(b) || isGroupItem(b)) - Number(isArea(a) || isGroupItem(a)) || (isGroupItem(a) && isGroupItem(b) ? groupAncestors(canvas, a.id).length - groupAncestors(canvas, b.id).length : 0)).slice(0, limit);
  return (
    <div className="canvas-mini" style={{ width, height }} aria-hidden>
      {ordered.map((one) => {
        const kind = isArea(one) || isGroupItem(one) ? "area" : itemKind(one);
        const box = {
          left: offsetX + (one.x - minX) * scale,
          top: offsetY + (one.y - minY) * scale,
          width: Math.max(2, one.width * scale),
          height: Math.max(2, one.height * scale),
        };
        const current = one.versions.find((v) => v.id === one.currentVersionId) ?? one.versions[0];
        const picture = automaticCanvasTarget(one.properties.canvas ?? null, sourceOf(one)).kind === "none" && kind === "image" && current ? current.blobHash : null;
        // Exactly one extra level: the decision is the pure function's, the
        // pull and the on-screen gate are the block's.
        const targetCanvasId = nestedTarget(one, window.location.origin);
        if (targetCanvasId !== null && canDeepen(depth, targetCanvasId, ancestors, box.width, box.height)) {
          return <NestedCanvasBlock key={one.id} targetCanvasId={targetCanvasId} home={home} item={one} box={box} depth={depth} ancestors={ancestors} />;
        }
        // Past depth 2, or small, or a cycle: a canvas inside the picture is
        // a block, not a picture.
        const label = box.width > 60 && box.height > 14 ? one.title : "";
        return (
          <span
            key={one.id}
            className={`canvas-mini-item kind-${kind}${isCanvasItem(one) ? " nested" : ""}`}
            style={box}
            title={one.title}
          >
            {picture && <SourcePicture canvasId={canvasId} home={home} hash={picture} />}
            {label}
          </span>
        );
      })}
    </div>
  );
}

/**
 * A canvas block inside a depth-1 picture that deepened (isocan-wq6.5): the
 * referenced canvas's OWN picture at depth 2, pulled through the same
 * source-snapshot path as the direct card — `sourceSnapshot` with the
 * automatic-exclusion policy, never a raw `getSnapshot` bypass — and only
 * while on screen. Held state is dropped when the block leaves the screen,
 * the same bound `useOnScreen` puts on live thumbnails: the ceiling is what
 * is on screen, not everything ever scrolled past. Refusal, offline, or a
 * target that stops answering leaves the plain titled block, never a blank
 * rectangle.
 */
function NestedCanvasBlock({
  targetCanvasId,
  home,
  item,
  box,
  depth,
  ancestors,
}: {
  targetCanvasId: string;
  home: string;
  item: Item;
  box: { left: number; top: number; width: number; height: number };
  depth: number;
  ancestors: Set<string>;
}) {
  const { ref, onScreen } = useOnScreen<HTMLSpanElement>();
  const [nested, setNested] = useState<CanvasContents | null>(null);

  useEffect(() => {
    if (!onScreen || home !== window.location.origin) return;
    let live = true;
    const controller = new AbortController();
    sourceSnapshot({ canvasId: targetCanvasId, expectedHome: home }, controller.signal)
      .then((snapshot) => {
        if (live) setNested(snapshot.canvas);
      })
      .catch(() => {
        // The door refused, the home is away, or the target is gone: the
        // titled block is the honest fallback.
        if (live) setNested(null);
      });
    return () => {
      live = false;
      controller.abort();
    };
  }, [onScreen, targetCanvasId, home]);
  useEffect(() => {
    // Off screen (past the grace window): release the held picture.
    if (!onScreen) setNested(null);
  }, [onScreen]);

  const label = box.width > 60 && box.height > 14 ? item.title : "";
  const nestedItems = nested ? Object.values(nested.items) : [];
  // The double border eats a couple of pixels; the inner picture fits what
  // is left rather than overflowing the block.
  const innerWidth = Math.max(0, box.width - 4);
  const innerHeight = Math.max(0, box.height - 4);

  return (
    <span
      ref={ref}
      className={`canvas-mini-item kind-canvas nested${nestedItems.length > 0 ? " has-nested-mini" : ""}`}
      style={box}
      title={item.title}
    >
      {nested && nestedItems.length > 0 && innerWidth > 0 && innerHeight > 0 ? (
        <Miniature
          home={home}
          canvasId={targetCanvasId}
          canvas={nested}
          items={nestedItems}
          width={innerWidth}
          height={innerHeight}
          depth={depth + 1}
          ancestors={new Set([...ancestors, targetCanvasId])}
        />
      ) : (
        label
      )}
    </span>
  );
}

function SourcePicture({ canvasId, home, hash }: { canvasId: string; home: string; hash: string }) {
  const scope = `${canvasId}:${home}:${hash}`;
  const [image, setImage] = useState<{ scope: string; url: string } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let url: string | null = null;
    void sourcePicture(canvasId, hash, home, controller.signal).then((blob) => {
      if (controller.signal.aborted) return;
      url = URL.createObjectURL(blob); setImage({ scope, url });
    }).catch(() => {});
    return () => { controller.abort(); if (url) URL.revokeObjectURL(url); };
  }, [canvasId, home, hash, scope]);
  return image?.scope === scope ? <img src={image.url} alt="" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "contain" }} /> : null;
}
