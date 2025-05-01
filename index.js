const http = require('http');
const express = require('express');
const Docker = require('dockerode');
const httpProxy = require('http-proxy');

const docker = new Docker({ socketPath: '/var/run/docker.sock' });
const proxy = httpProxy.createProxy({});
const db = new Map();

const reverseproxyApp = express();
const mgmapi = express();
mgmapi.use(express.json()); // Needed to parse JSON bodies

// Listen to Docker container events
docker.getEvents((err, stream) => {
  if (err) {
    console.error("Error getting Docker events:", err);
    return;
  }

  stream.on('data', async (chunk) => {
    try {
      const event = JSON.parse(chunk.toString());

      if (event.Type === 'container' && event.Action === 'start') {
        const container = docker.getContainer(event.id);
        const containerInfo = await container.inspect();

        const containerName = containerInfo.Name.replace(/^\//, '');
        const networks = containerInfo.NetworkSettings.Networks;
        const bridge = networks['bridge'];
        const containerIp = bridge?.IPAddress || containerInfo.NetworkSettings.IPAddress;
        const exposedPorts = Object.keys(containerInfo.Config.ExposedPorts || {});

        let defaultPort = null;
        if (exposedPorts.length > 0) {
          const [port, type] = exposedPorts[0].split('/');
          if (type === 'tcp') {
            defaultPort = port;
          }
        }

        if (containerIp && defaultPort) {
          console.log(`Registering: ${containerName}.localhost → http://${containerIp}:${defaultPort}`);
          db.set(containerName, { containerIp, defaultPort });
        }
      }
    } catch (error) {
      console.error("Error handling Docker event:", error);
    }
  });
});

// Reverse proxy routing
reverseproxyApp.use((req, res) => {
  const hostname = req.hostname;
  const subdomain = hostname.split('.')[0];

  if (!db.has(subdomain)) {
    res.status(404).send("Container not found");
    return;
  }

  const { containerIp, defaultPort } = db.get(subdomain);
  const target = `http://${containerIp}:${defaultPort}`;
  console.log(`Forwarding ${hostname} → ${target}`);

  proxy.web(req, res, { target, changeOrigin: true }, (err) => {
    console.error("Proxy error:", err.message);
    res.status(500).send("Proxy failed");
  });
});

// Management API
mgmapi.post("/containers", async (req, res) => {
  try {
    const { image, tag = "latest" } = req.body;
    if (!image) {
      return res.status(400).json({ status: "error", message: "Image is required" });
    }

    const images = await docker.listImages();
    const imageExists = images.some(img =>
      (img.RepoTags || []).includes(`${image}:${tag}`)
    );

    if (!imageExists) {
      console.log(`Pulling image: ${image}:${tag}`);
      await new Promise((resolve, reject) => {
        docker.pull(`${image}:${tag}`, (err, stream) => {
          if (err) return reject(err);
          docker.modem.followProgress(stream, resolve);
        });
      });
    }

    const container = await docker.createContainer({
      Image: `${image}:${tag}`,
      Tty: false,
      HostConfig: {
        AutoRemove: true
      }
    });

    await container.start();
    const { Name } = await container.inspect();

    res.json({
      status: "success",
      container: `${Name.replace(/^\//, '')}.localhost`
    });
  } catch (error) {
    console.error("Error creating container:", error);
    res.status(500).json({ status: "error", message: error.message });
  }
});

// Start servers
mgmapi.listen(8080, () => console.log("Management API is running on PORT 8080."));
http.createServer(reverseproxyApp).listen(80, () => {
  console.log("Reverse proxy is listening on PORT 80.");
});
