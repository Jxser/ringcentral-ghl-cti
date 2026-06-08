const { loadConfigFromEnv, validateRuntimeConfig } = require("./src/config");
const { createApp, listen } = require("./src/server");

async function main() {
  const config = loadConfigFromEnv();
  validateRuntimeConfig(config);
  const app = createApp({ config });
  const server = await listen(app, config.port);
  const address = server.address();
  console.log(`RingCentral GHL CTI backend listening on ${address.port}`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
