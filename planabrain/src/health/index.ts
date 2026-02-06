import fs from "fs";
import path from "path";
import dotenv from "dotenv";

function loadEnv(): void {
  const explicitPath = process.env.DOTENV_CONFIG_PATH;
  if (explicitPath) {
    dotenv.config({ path: explicitPath });
    return;
  }

  const cwd = process.cwd();
  const candidates = [path.join(cwd, ".env"), path.join(cwd, "..", ".env")];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      dotenv.config({ path: candidate });
      return;
    }
  }

  dotenv.config();
}

loadEnv();

import { startHealthServer } from "./server.js";
startHealthServer();
