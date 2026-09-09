"use strict";

const ROOT = new URL("./", self.location.href);

const PREFIX = new URL(
"service/",
ROOT
).pathname;

const SCRAMJET_ALL = new URL(
"S/SA.js",
ROOT
).href;

self.__scramjet$config = {
prefix: PREFIX,

files: {
    all: new URL("S/SA.js", ROOT).href,
    sync: new URL("S/SS.js", ROOT).href,
    wasm: new URL("S/SW.wasm", ROOT).href
},

all: SCRAMJET_ALL,
sync: new URL("S/SS.js", ROOT).href,
wasm: new URL("S/SW.wasm", ROOT).href

};

try {
importScripts(SCRAMJET_ALL);
} catch (error) {
console.error(
"Veil: unable to load S/SA.js",
error
);
}

let scramjet = null;

try {
if (typeof ScramjetServiceWorker === "function") {
scramjet = new ScramjetServiceWorker();
} else {
console.error(
"Veil: ScramjetServiceWorker is not available."
);
}
} catch (error) {
console.error(
"Veil: failed to initialize Scramjet",
error
);
}

self.addEventListener("install", event => {
self.skipWaiting();
});

self.addEventListener("activate", event => {
event.waitUntil(
self.clients.claim()
);
});

self.addEventListener("fetch", event => {
if (!scramjet) return;

const requestURL = new URL(
    event.request.url
);

if (
    requestURL.origin !== self.location.origin ||
    !requestURL.pathname.startsWith(PREFIX)
) {
    return;
}

event.respondWith(
    Promise.resolve(
        scramjet.fetch(event)
    ).catch(error => {
        console.error(
            "Veil Scramjet fetch failed:",
            error
        );

        return new Response(
            "Veil could not proxy this request.",
            {
                status: 502,
                headers: {
                    "Content-Type": "text/plain; charset=utf-8"
                }
            }
        );
    })
);

});