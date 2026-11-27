import { CANARY_RULE, verifyCanary } from "./canary.ts";
import { prepareSession } from "./session.ts";
import { ensureToolchain } from "./toolchain.ts";
import { WebDriverClient } from "./webdriver.ts";

async function main(): Promise<void> {
  const toolchain = await ensureToolchain();
  const session = prepareSession({
    firefoxDir: toolchain.firefoxDir,
    uboXpiPath: toolchain.uboXpiPath,
    mode: "filtered",
    userFilters: CANARY_RULE,
  });

  let client: WebDriverClient | undefined;
  try {
    client = await WebDriverClient.launch({
      geckodriverBin: toolchain.geckodriverBin,
      session,
      headless: true,
    });

    const result = await verifyCanary(client);
    console.log(
      `Canary passed in ${result.canaryMs}ms (observed background-color: ${result.observedColor})`,
    );
  } finally {
    await client?.close();
    session.cleanup();
  }
}

await main();
