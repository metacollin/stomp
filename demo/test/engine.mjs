// The engine the tests use: the C++ engine as WebAssembly, through the editor's adapter
// (demo/js/engine.js). Loading it is the one asynchronous step.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const E = await require('../js/engine.js').ready;

export default E;
export const { compile, compiler, lexer, lex, model3d, kicad, outline, syntax } = E;
