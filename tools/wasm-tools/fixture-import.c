
__attribute__((import_module("env"))) __attribute__((import_name("log"))) void log_it(int);
__attribute__((export_name("trigger"))) void trigger(void) { log_it(1); }
