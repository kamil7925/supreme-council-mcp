import { loadEnv, readConfig, publicConfig } from '../src/config.js';
loadEnv();
console.log(JSON.stringify(publicConfig(readConfig()), null, 2));
