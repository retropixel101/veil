importScripts('/S/SA.js');

const scramjet = new ScramjetServiceWorker();

self.addEventListener('fetch', (event) => {
    // Check if the request is meant for our proxy prefix
    if (event.request.url.startsWith(location.origin + __scramjet$config.prefix)) {
        event.respondWith(scramjet.fetch(event));
    }
});
