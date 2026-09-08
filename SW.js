importScripts(new URL("../S/SA.js", self.location).href);

const scramjet = new ScramjetServiceWorker();

self.addEventListener("fetch", (event) => {
    if (
        event.request.url.startsWith(
            location.origin + __scramjet$config.prefix
        )
    ) {
        event.respondWith(scramjet.fetch(event));
    }
});