import os from 'node:os';
import path from 'node:path';

// Portable boundary for the extracted evidence modules. No router/auth discovery.
export const STATE_DIR = path.resolve(process.env.HELIX_HOME || path.join(os.homedir(), '.helix'));
