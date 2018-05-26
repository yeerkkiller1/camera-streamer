interface PollingState<T> {
    path: string;
    frequencyMs: number;
    currentState: T|undefined;
    parse: (lines: string[]) => T;
    callbacks: ((state: T) => void)[];
}

let pollingStates: { [path: string]: PollingState<object> } = {};

async function getState(pollingState: PollingState<object>): Promise<object> {
    let result = await fetch(pollingState.path);
    let text = await result.text();
    let lines = text.split("\n").filter(x => !!x);

    return pollingState.parse(lines);
}

async function watchLoop(state: PollingState<object>) {
    let newState: object;
    try {
        newState = await getState(state);
    } finally {
        setTimeout(() => watchLoop(state), state.frequencyMs);
    }

    if(JSON.stringify(newState) === JSON.stringify(state.currentState)) return;

    state.currentState = newState;
    console.log(`${state.path} changed`);

    for(let callback of state.callbacks) {
        try {
            callback(state.currentState);
        } catch(e) {
            console.error(`${state.path} callback error ${e}`);
        }
    }
}

export function watch<T>(path: string, frequencyMs: number, parse: (lines: string[]) => T, callback: (state: T) => void) {
    if(!(path in pollingStates)) {
        pollingStates[path] = {
            path,
            frequencyMs,
            callbacks: [],
            parse: parse as any,
            currentState: undefined
        };

        watchLoop(pollingStates[path]);
    }

    let state = pollingStates[path] as any as PollingState<T>;

    if(state.parse !== parse) {
        throw new Error(`Inconsistent parses for path ${path}`);
    }

    state.callbacks.push(callback);
    if(state.currentState !== undefined) {
        callback(state.currentState);
    }
}
export function unwatch<T>(callback: (state: T) => void) {
    for(let key in pollingStates) {
        let state = pollingStates[key];
        let index = state.callbacks.indexOf(callback as any);
        if(index >= 0) {
            state.callbacks.splice(index, 1);
        }
    }
}