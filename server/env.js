// Loads <project>/.env into process.env (Node's built-in parser). Imported first by index.js so every
// module sees the values; variables already set in the shell win over the file.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');
if (fs.existsSync(file)) process.loadEnvFile(file);
