const { getRuntimeConfigIssues, isPlaceholder, loadConfigFromEnv } = require("./config");

function status(value) {
  if (!String(value || "").trim()) return "missing";
  return isPlaceholder(value) ? "placeholder" : "set";
}

function printLine(label, value) {
  console.log(`${label}: ${status(value)}`);
}

function main() {
  const config = loadConfigFromEnv();
  const rc = config.defaults?.ringcentral || {};
  const ghl = config.defaults?.ghl || {};
  const issues = getRuntimeConfigIssues(config);

  console.log("Runtime config");
  printLine("PUBLIC_BASE_URL", config.publicBaseUrl);
  printLine("GHL_OAUTH_CLIENT_ID", config.ghlOAuth?.clientId);
  printLine("GHL_OAUTH_CLIENT_SECRET", config.ghlOAuth?.clientSecret);
  printLine("GHL_APP_ID", config.ghlApp?.id);
  printLine("GHL_APP_SHARED_SECRET", config.ghlApp?.sharedSecret);
  printLine("RINGCENTRAL_CLIENT_ID", rc.clientId);
  printLine("RINGCENTRAL_CLIENT_SECRET", rc.clientSecret);

  console.log("");
  console.log("App config");
  printLine("APP_CONFIG_PATH", config.appConfigPath);
  printLine("GHL call provider id", ghl.callConversationProviderId || ghl.conversationProviderId);
  printLine("GHL SMS provider id", ghl.smsConversationProviderId || ghl.conversationProviderId);

  if (!issues.length) {
    console.log("");
    console.log("Config looks ready.");
    return;
  }

  console.log("");
  console.log("Missing or placeholder values:");
  for (const issue of issues) console.log(`- ${issue}`);
  process.exitCode = 1;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { main };
