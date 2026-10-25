#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <fcntl.h>
#include <poll.h>

int main(void) {
    char buf[16384];
    
    // Poll stdin with 500ms timeout so we never hang even if pipe remains open
    struct pollfd pfd = { .fd = STDIN_FILENO, .events = POLLIN };
    int pr = poll(&pfd, 1, 500);
    if (pr <= 0) {
        fputs("{\"decision\":\"allow\"}\n", stdout);
        fflush(stdout);
        return 0;
    }

    ssize_t n = read(STDIN_FILENO, buf, sizeof(buf) - 1);
    if (n <= 0) {
        fputs("{\"decision\":\"allow\"}\n", stdout);
        fflush(stdout);
        return 0;
    }
    buf[n] = '\0';

    // 1. read_file bounds
    if (strstr(buf, "\"read_file\"")) {
        // Binary files: bound to line 1
        if (strstr(buf, ".sqlite") || strstr(buf, ".db") || strstr(buf, ".wasm") || 
            strstr(buf, ".bin") || strstr(buf, ".pyc") || strstr(buf, ".png") || 
            strstr(buf, ".jpg") || strstr(buf, ".ico") || strstr(buf, ".pdf") || strstr(buf, ".dylib")) {
            fputs("{\"decision\":\"allow\",\"overwrite\":{\"StartLine\":1,\"EndLine\":1}}\n", stdout);
            fflush(stdout);
            return 0;
        }
        // Lockfiles & minified: bound to 25 lines
        if (strstr(buf, "package-lock.json") || strstr(buf, "pnpm-lock.yaml") || 
            strstr(buf, "yarn.lock") || strstr(buf, "Cargo.lock") ||
            strstr(buf, ".min.js") || strstr(buf, ".min.css") || strstr(buf, ".map")) {
            fputs("{\"decision\":\"allow\",\"overwrite\":{\"StartLine\":1,\"EndLine\":25}}\n", stdout);
            fflush(stdout);
            return 0;
        }
        // Unbounded reads: cap at 300 lines
        if (!strstr(buf, "\"EndLine\"") || strstr(buf, "\"EndLine\":null")) {
            fputs("{\"decision\":\"allow\",\"overwrite\":{\"StartLine\":1,\"EndLine\":300}}\n", stdout);
            fflush(stdout);
            return 0;
        }
    }

    // 2. invoke_subagent: tier governor to flash
    if (strstr(buf, "\"invoke_subagent\"")) {
        if (strstr(buf, "\"Model\":\"pro\"") || strstr(buf, "\"Model\":\"inherit\"") || !strstr(buf, "\"Model\"")) {
            fputs("{\"decision\":\"allow\",\"overwrite\":{\"Model\":\"flash\"}}\n", stdout);
            fflush(stdout);
            return 0;
        }
    }

    // Fast allow for all other tools
    fputs("{\"decision\":\"allow\"}\n", stdout);
    fflush(stdout);
    return 0;
}
