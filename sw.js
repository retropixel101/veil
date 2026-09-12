const ROOT = new URL("./", self.location.href);

const PREFIX =
    new URL("service/", ROOT).pathname;

const SCRAMJET_ASSETS = {
    all: new URL(
        "sj/scramjet.all.js",
        ROOT
    ).href,

    sync: new URL(
        "sj/scramjet.sync.js",
        ROOT
    ).href,

    wasm: new URL(
        "sj/scramjet.wasm.wasm",
        ROOT
    ).href
};

const BAREMUX_WORKER = new URL(
    "bm/worker.js",
    ROOT
).href;

const EPOXY = new URL(
    "ep/index.mjs",
    ROOT
).href;

const DEFAULT_WISP =
    "wss://wisp-backend-weyl.onrender.com";

let wispUrl = DEFAULT_WISP;

let scramjet = null;
let bareConnection = null;
let scramjetReady = false;
let bareMuxReady = false;

let adBlock = false;

const blockedHosts = new Set([
    "doubleclick.net",
    "googlesyndication.com",
    "googleadservices.com",
    "googletagmanager.com",
    "adservice.google.com"
]);

function normalizeWisp(url) {
    if (!url) return DEFAULT_WISP;

    url = String(url).trim();

    if (url.startsWith("http://")) {
        url = "ws://" + url.slice(7);
    } else if (url.startsWith("https://")) {
        url = "wss://" + url.slice(8);
    }

    return url.replace(/\/+$/, "");
}

async function initializeScramjet() {
    if (scramjetReady) {
        return scramjet;
    }

    try {
        const workerModule =
            await import(
                SCRAMJET_ASSETS.all
            );

        if (
            workerModule &&
            workerModule.ScramjetServiceWorker
        ) {
            scramjet =
                new workerModule.ScramjetServiceWorker({
                    prefix: PREFIX,
                    files: SCRAMJET_ASSETS
                });
            scramjetReady = true;
            return scramjet;
        }
    } catch (error) {
        console.error(
            "Scramjet module initialization failed:",
            error
        );
    }

    try {
        const loaded =
            await import(
                SCRAMJET_ASSETS.sync
            );

        if (
            loaded &&
            loaded.ScramjetServiceWorker
        ) {
            scramjet =
                new loaded.ScramjetServiceWorker({
                    prefix: PREFIX,
                    files: SCRAMJET_ASSETS
                });

            scramjetReady = true;

            return scramjet;
        }
    } catch (error) {
        console.error(
            "Scramjet fallback initialization failed:",
            error
        );
    }

    throw new Error(
        "Unable to initialize the Scramjet service worker."
    );
}

async function initializeBareMux() {
    if (
        bareMuxReady &&
        bareConnection
    ) {
        return bareConnection;
    }

    try {
        const BareMux =
            await import(
                new URL(
                    "bm/index.js",
                    ROOT
                ).href
            );

        const Connection =
            BareMux.BareMuxConnection ||
            BareMux.default?.BareMuxConnection;

        if (!Connection) {
            throw new Error(
                "BareMuxConnection was not found."
            );
        }

        bareConnection =
            new Connection(
                BAREMUX_WORKER
            );

        await setBareMuxTransport(
            EPOXY,
            wispUrl
        );

        bareMuxReady = true;

        return bareConnection;
    } catch (error) {
        bareMuxReady = false;
        bareConnection = null;

        throw error;
    }
}

async function setBareMuxTransport(
    transport,
    wisp
) {
    if (!bareConnection) return;

    const target =
        transport ||
        EPOXY;

    const server =
        normalizeWisp(wisp);

    await bareConnection.setTransport(
        target,
        [
            {
                wisp: server
            }
        ]
    );
}

async function updateWisp(url) {
    const normalized =
        normalizeWisp(url);

    if (!normalized) return;

    if (normalized === wispUrl) {
        return;
    }

    wispUrl = normalized;

    if (bareConnection) {
        try {
            await setBareMuxTransport(
                EPOXY,
                wispUrl
            );
        } catch (error) {
            console.warn(
                "Failed to update BareMux Wisp:",
                error
            );

            bareConnection = null;
            bareMuxReady = false;
        }
    }
}

function isBlocked(request) {
    if (!adBlock) {
        return false;
    }

    try {
        const hostname =
            new URL(request.url).hostname
                .toLowerCase();

        for (const blocked of blockedHosts) {
            if (
                hostname === blocked ||
                hostname.endsWith("." + blocked)
            ) {
                return true;
            }
        }
    } catch {}

    return false;
}

self.addEventListener(
    "message",
    event => {
        const data = event.data;

        if (!data) return;

        if (
            data.type === "veil-config" &&
            data.wisp
        ) {
            event.waitUntil(
                updateWisp(data.wisp)
            );
        }

        if (
            data.type === "veil-adblock"
        ) {
            adBlock = Boolean(
                data.enabled
            );
        }
    }
);

self.addEventListener(
    "install",
    () => {
        self.skipWaiting();
    }
);

self.addEventListener(
    "activate",
    event => {
        event.waitUntil(
            self.clients.claim()
        );
    }
);

async function handleScramjetRequest(
    event
) {
    if (!scramjet) {
        await initializeScramjet();
    }

    if (!bareConnection) {
        await initializeBareMux();
    }

    if (
        typeof scramjet.fetch ===
        "function"
    ) {
        return scramjet.fetch(event);
    }

    if (
        typeof scramjet.route ===
        "function"
    ) {
        const routed =
            await scramjet.route(event);

        if (routed) {
            return routed;
        }
    }

    return fetch(event.request);
}

self.addEventListener(
    "fetch",
    event => {
        const url =
            new URL(event.request.url);

        if (
            !url.pathname.startsWith(
                PREFIX
            )
        ) {
            return;
        }

        if (
            isBlocked(event.request)
        ) {
            event.respondWith(
                new Response(
                    "",
                    {
                        status: 204
                    }
                )
            );

            return;
        }

        event.respondWith(
            handleScramjetRequest(event)
                .catch(error => {
                    console.error(
                        "Veil proxy request failed:",
                        error
                    );

                    return new Response(
                        `
                        <!DOCTYPE html>
                        <html>
                        <head>
                            <meta charset="UTF-8">
                            <title>Veil Error</title>
                            <style>
                                html,body {
                                    margin:0;
                                    width:100%;
                                    height:100%;
                                    background:#0a0a0a;
                                    color:#e4e4e7;
                                    font-family:Arial,sans-serif;
                                    display:flex;
                                    align-items:center;
                                    justify-content:center;
                                }

                                .box {
                                    text-align:center;
                                    max-width:600px;
                                    padding:30px;
                                }

                                h1 {
                                    margin-bottom:10px;
                                }

                                p {
                                    color:#71717a;
                                    line-height:1.6;
                                }
                            </style>
                        </head>
                        <body>
                            <div class="box">
                                <h1>Connection Error</h1>
                                <p>
                                    Veil could not load this page through
                                    the selected proxy server.
                                </p>
                            </div>
                        </body>
                        </html>
                        `,
                        {
                            status: 502,
                            headers: {
                                "Content-Type":
                                    "text/html; charset=utf-8"
                            }
                        }
                    );
                })
        );
    }
);