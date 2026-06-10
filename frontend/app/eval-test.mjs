// Test whether strict eval can access imported bindings from ES modules
import { haversineKm } from './geo.js';

// Test 1: Can eval see imported binding?
eval('globalThis.test1 = function() { return typeof haversineKm; }');
console.log('Test 1 (eval sees import):', globalThis.test1());

// Test 2: Can eval see local const?
const localVar = 42;
eval('globalThis.test2 = function() { return localVar; }');
console.log('Test 2 (eval sees local const):', globalThis.test2());

// Test 3: Can eval'd function call imported fn?
eval('globalThis.test3 = function(a,b,c,d) { return haversineKm(a,b,c,d); }');
console.log('Test 3 (eval calls import):', globalThis.test3(48, -123, 49, -124));

// Test 4: Module-level function declaration test
eval(`
function test4_fn() { return haversineKm(48, -123, 49, -124); }
globalThis.test4 = test4_fn;
`);
console.log('Test 4 (module-level fn sees import):', globalThis.test4());

// Test 5: Can it see a complex import like the full routeAroundLand?
// We need to import it first
import { routeAroundLand } from './geo.js';
eval(`
function test5_fn(a,b) { return routeAroundLand(a, b, [], []); }
globalThis.test5 = test5_fn;
`);
console.log('Test 5 (fn sees routeAroundLand):', typeof globalThis.test5([48,-123],[49,-124]), '(expected null or object)');

// Test 6: Can preSmooth reference itself across evals?
eval(`
function fnA() { return 'fnA'; }
function fnB() { return fnA() + '+fnB'; }
globalThis.fnB = fnB;
`);
console.log('Test 6 (cross-eval reference):', globalThis.fnB());
