// Get the repository subfolder path automatically (e.g., "/repository-name/")
const repoPath = window.location.pathname.endsWith('/') ? window.location.pathname : window.location.pathname + '/';

async function initProxy() {
    window.__scramjet$config = {
        prefix: repoPath + 'service/', // Correct prefix for GitHub subfolders
        config: repoPath + 'scram/scramjet.config.js',
        all: repoPath + 'scram/scramjet.all.js',
        sync: repoPath + 'scram/scramjet.sync.js',
        wasm: repoPath + 'scram/scramjet.wasm.wasm',
    };

    // Register the service worker inside the subfolder path
    await navigator.serviceWorker.register(repoPath + 'sw.js', {
        scope: __scramjet$config.prefix
    });

    // Initialize Bare-Mux connection using your live private Render server
    const connection = new BareMux.BareMuxConnection();
    await connection.setTransport('/baremux/worker.js', [{ wisp: 'wss://://onrender.com' }]);

    console.log("Frontend connected to live private Wisp backend!");
}

initProxy();

function launchUrl(url) {
    const encoded = __scramjet$config.prefix + scramjet.encodeUrl(url);
    window.location.href = encoded;
}
