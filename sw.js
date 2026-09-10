"use strict";

const ROOT =
    new URL("./", self.location.href);

const PREFIX =
    new URL(
        "service/",
        ROOT
    ).pathname;

const SCRAMJET_ALL =
    new URL(
        "sj/scramjet.all.js",
        ROOT
    ).href;

const BAREMUX_WORKER =
    new URL(
        "bm/worker.js",
        ROOT
    ).href;

const EPOXY_TRANSPORT =
    new URL(
        "ep/index.mjs",
        ROOT
    ).href;

const WISP =
    "wss://wisp-backend-weyl.onrender.com";


self.__scramjet$config = {
    prefix: PREFIX,

    files: {
        all: SCRAMJET_ALL,

        sync: new URL(
            "sj/scramjet.sync.js",
            ROOT
        ).href,

        wasm: new URL(
            "sj/scramjet.wasm.wasm",
            ROOT
        ).href
    }
};


let scramjet = null;
let bareConnection = null;
let adBlock = false;
let initError = null;


const BLOCKED_PATTERNS = [
    "doubleclick.net",
    "googlesyndication.com",
    "googleadservices.com",
    "adservice.google.com",
    "amazon-adsystem.com",
    "adnxs.com",
    "ads.yahoo.com",
    "advertising.com",
    "adtechus.com",
    "rubiconproject.com",
    "pubmatic.com",
    "criteo.com",
    "taboola.com",
    "outbrain.com",
    "moatads.com",
    "casalemedia.com",
    "adsafeprotected.com",
    "scorecardresearch.com",
    "quantserve.com",
    "demdex.net",
    "chartbeat.com",
    "facebook.com/tr",
    "facebook.com/ads",
    "graph.facebook.com/ads",
    "graph.facebook.com/pixel",
    "twitter.com/i/ads",
    "analytics.twitter.com",
    "ads-api.twitter.com",
    "/adserver/",
    "/advertising/",
    "/ads/",
    "/banner/",
    "/tracking/",
    "/tracker/",
    "/metrics/",
    "/analytics/"
];


function isAdBlocked(url) {
    if (!adBlock) {
        return false;
    }

    const value =
        String(url).toLowerCase();

    return BLOCKED_PATTERNS.some(
        pattern =>
            value.includes(
                pattern.toLowerCase()
            )
    );
}


async function initializeTransport() {

    if (bareConnection) {
        return bareConnection;
    }

    if (
        typeof BareMux ===
        "undefined" ||
        typeof BareMux.BareMuxConnection !==
        "function"
    ) {
        throw new Error(
            "Local BareMux was not loaded."
        );
    }

    bareConnection =
        new BareMux.BareMuxConnection(
            BAREMUX_WORKER
        );

    await bareConnection.setTransport(
        EPOXY_TRANSPORT,
        [
            {
                wisp: WISP
            }
        ]
    );

    return bareConnection;
}


try {

    importScripts(
        SCRAMJET_ALL
    );

    if (
        typeof $scramjetLoadWorker !==
        "function"
    ) {
        throw new Error(
            "$scramjetLoadWorker() was not found."
        );
    }

    const worker =
        $scramjetLoadWorker();

    if (
        !worker ||
        typeof worker.ScramjetServiceWorker !==
        "function"
    ) {
        throw new Error(
            "ScramjetServiceWorker was not found."
        );
    }

    scramjet =
        new worker.ScramjetServiceWorker();

    importScripts(
        new URL(
            "bm/index.js",
            ROOT
        ).href
    );

    console.log(
        "Veil: local Scramjet loaded."
    );

} catch (error) {

    initError = error;

    console.error(
        "Veil: engine initialization failed.",
        error
    );
}


self.addEventListener(
    "install",
    event => {

        event.waitUntil(
            self.skipWaiting()
        );
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


self.addEventListener(
    "message",
    event => {

        const data =
            event.data;

        if (!data) {
            return;
        }

        if (
            data.type ===
            "veil-config"
        ) {

            if (
                typeof data.adBlock ===
                "boolean"
            ) {
                adBlock =
                    data.adBlock;
            }

            console.log(
                "Veil: configuration updated.",
                {
                    adBlock
                }
            );
        }
    }
);


if (scramjet) {

    scramjet.addEventListener(
        "request",
        async event => {

            event.response =
                (async () => {

                    const requestUrl =
                        event.url instanceof URL
                            ? event.url
                            : new URL(
                                event.url
                            );

                    if (
                        isAdBlocked(
                            requestUrl
                        )
                    ) {

                        return new Response(
                            null,
                            {
                                status: 204
                            }
                        );
                    }


                    try {

                        await initializeTransport();

                        return await bareConnection.fetch(
                            requestUrl,
                            {
                                method:
                                    event.method,

                                body:
                                    event.body,

                                headers:
                                    event.requestHeaders,

                                credentials:
                                    "include",

                                redirect:
                                    "manual"
                            }
                        );

                    } catch (error) {

                        console.error(
                            "Veil: proxy request failed.",
                            error
                        );

                        return new Response(
                            "Veil Scramjet error: " +
                            (
                                error?.message ||
                                String(error)
                            ),
                            {
                                status: 502,

                                headers: {
                                    "Content-Type":
                                        "text/plain; charset=utf-8"
                                }
                            }
                        );
                    }
                })();
        }
    );
}


self.addEventListener(
    "fetch",
    event => {

        if (!scramjet) {

            if (initError) {
                console.error(
                    "Veil: Scramjet unavailable:",
                    initError
                );
            }

            return;
        }


        const url =
            new URL(
                event.request.url
            );


        if (
            url.origin !==
            self.location.origin
        ) {
            return;
        }


        if (
            !url.pathname.startsWith(
                PREFIX
            )
        ) {
            return;
        }


        event.respondWith(
            (async () => {

                try {

                    await scramjet.loadConfig();

                    if (
                        scramjet.route(
                            event
                        )
                    ) {
                        return await scramjet.fetch(
                            event
                        );
                    }

                    return fetch(
                        event.request
                    );

                } catch (error) {

                    console.error(
                        "Veil: Scramjet fetch failed.",
                        error
                    );

                    return new Response(
                        "Veil Scramjet error: " +
                        (
                            error?.message ||
                            String(error)
                        ),
                        {
                            status: 502,

                            headers: {
                                "Content-Type":
                                    "text/plain; charset=utf-8"
                            }
                        }
                    );
                }
            })()
        );
    }
);