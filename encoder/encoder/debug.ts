let ENABLE_FUNCTION_RENAMING = true;

function EscapeIdentifier(name: string) {
    // TODO: Do this right
    let output = "";
    for(let i = 0; i < name.length; i++) {
        let ch = name[i];
        if(!/[a-zA-Z_]/.test(ch)) {
            ch = "_";
        }
        output += ch;
    }
    return output;
}

const functionCached = Symbol();
/** Run this, and we will give your function a parent function with the given name.
 *      This lets you make callstacks better for debugging.
 */
export function WrapWithFunctionName<T extends Function>(name: string, fnc: T): T {
    if(!ENABLE_FUNCTION_RENAMING) return fnc;
    name = EscapeIdentifier(name);
    if(functionCached in fnc) {
        return (fnc as any)[functionCached];
    }
    let returnFnc = new Function('fnc', `
        return function ${name}() {
            return fnc.call(this, arguments);
        }
    `)(fnc);

    Object.assign(fnc, { [functionCached]: returnFnc });

    return returnFnc;
}