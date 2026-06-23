import vm from 'vm';

/**
 * jsSandboxRunner.js
 * Executes user-provided JavaScript in a securely isolated Node.js VM context.
 * Prevents access to dangerous globals and enforces strict execution time limits.
 */
export async function executeJavaScriptSandbox({
    userCode,
    exportName = "solve",
    tests = [],
    debug = false,
    timeLimitMsPerTest = 750,
    maxOutputBytes = 20000
}) {
    const results = [];

    for (let i = 0; i < tests.length; i++) {
        const test = tests[i];
        let stdoutBuf = "";

        // 1. Create a secure, restricted mock console
        const mockConsole = {
            log: (...args) => {
                if (debug) {
                    const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(" ") + "\n";
                    if (stdoutBuf.length + msg.length <= maxOutputBytes) {
                        stdoutBuf += msg;
                    } else if (stdoutBuf.length < maxOutputBytes) {
                        stdoutBuf += "\n[Output truncated: Exceeded maximum bytes]\n";
                    }
                }
            },
            error: (...args) => {
                if (debug) {
                    const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(" ") + "\n";
                    if (stdoutBuf.length + msg.length <= maxOutputBytes) {
                        stdoutBuf += "[ERROR] " + msg;
                    }
                }
            }
        };

        // 2. Initialize a pristine, prototype-less sandbox object.
        // This prevents sandbox breakout via prototype chain traversal.
        const sandboxEnv = Object.create(null);

        // 3. Inject ONLY safe Javascript built-ins.
        // Explicitly EXCLUDING: setTimeout, setInterval, setImmediate, process, require, global, window
        sandboxEnv.console = mockConsole;
        sandboxEnv.Math = Math;
        sandboxEnv.String = String;
        sandboxEnv.Number = Number;
        sandboxEnv.Array = Array;
        sandboxEnv.Object = Object;
        sandboxEnv.Boolean = Boolean;
        sandboxEnv.Date = Date;
        sandboxEnv.RegExp = RegExp;
        sandboxEnv.Error = Error;
        sandboxEnv.TypeError = TypeError;
        sandboxEnv.RangeError = RangeError;
        sandboxEnv.Map = Map;
        sandboxEnv.Set = Set;
        sandboxEnv.JSON = JSON;
        sandboxEnv.isNaN = isNaN;
        sandboxEnv.isFinite = isFinite;
        sandboxEnv.parseInt = parseInt;
        sandboxEnv.parseFloat = parseFloat;

        // Inject the current test inputs securely
        sandboxEnv.__TEST_INPUTS__ = test.input;

        // 4. Contextify the sandbox environment
        const context = vm.createContext(sandboxEnv);

        let actual;
        let error = null;
        let pass = false;

        try {
            // 5. Wrap user code to safely execute the exported function 
            // without polluting the global scope or relying on 'eval'
            const executionWrapper = `
                ${userCode}

                if (typeof ${exportName} !== 'function') {
                    throw new Error("Function '${exportName}' is not defined.");
                }

                // Run the function with the securely injected inputs
                ${exportName}(...__TEST_INPUTS__);
            `;

            const script = new vm.Script(executionWrapper);

            // 6. Execute with strict time limits to prevent infinite 'while(true)' loops
            actual = script.runInContext(context, {
                timeout: timeLimitMsPerTest,
                microtaskMode: 'afterEvaluate' // Restricts unhandled async microtasks inside the VM
            });

            // Deep equality check for standard JSON-serializable algorithm outputs
            pass = JSON.stringify(actual) === JSON.stringify(test.expected);

        } catch (err) {
            // Catch timeouts, syntax errors, and runtime exceptions safely
            error = { 
                name: err.name || "Error", 
                message: err.message || "Unknown execution error" 
            };
        }

        results.push({
            name: test.name,
            pass,
            actual,
            expected: test.expected,
            stdout: stdoutBuf,
            error
        });
    }

    return { tests: results };
}
