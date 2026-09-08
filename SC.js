// Detects the GitHub Pages repository path dynamically
const repoPath = window.location.pathname.endsWith('/') ? window.location.pathname : window.location.pathname + '/';

async function initProxy() {
    window.__scramjet$config = {
        prefix: repoPath + 'service/',
        config: repoPath + 'S/scramjet.config.js',
        all: repoPath + 'S/SA.js',
        sync: repoPath + 'S/SS.js',
        wasm: repoPath + 'S/SW.wasm',
     };

    await navigator.serviceWorker.register(repoPath + "SW.js", {
        scope: __scramjet$config.prefix
    });

    const connection = new BareMux.BareMuxConnection();

    await connection.setTransport(
        repoPath + "baremux/worker.js",
        [
            {
                wisp: "wss://wisp-backend-weyl.onrender.com"
            }
        ]
    );

    console.log("Veil connection ready");
}

initProxy();

function launchUrl(url) {
    const encoded =
        __scramjet$config.prefix + scramjet.encodeUrl(url);

    window.location.href = encoded;
}