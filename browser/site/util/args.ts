import { parseParams, trueParam } from "./url";

export function getProgramArguments() {
    return parseParams(document.location.search.slice(1));
}

export function setProgramArgument(key: string, value: string) {
    let params = getProgramArguments();
    params[key] = value;

    let parts: string[] = [];
    for(let key in params) {
        let val = params[key];
        if(val === trueParam) {
            parts.push(`${key}`);
        } else {
            parts.push(`${key}=${encodeURIComponent(val)}`);
        }
    }

    history.pushState(null, undefined, "?" + parts.join("&"));
}