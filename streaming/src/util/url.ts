import { randomUID } from "./misc";

export const trueParam = randomUID("true");
export function parseParams(paramsStr: string) {
    let paramsRaw = paramsStr.split("&");
    let params: {[key: string]: string} = {};
    for(var i = 0; i < paramsRaw.length; i++) {
        let paramRaw = paramsRaw[i];
        let paramParts = paramRaw.split("=");
        let val: string = decodeURIComponent(paramParts[1]);
        if(paramParts.length === 1) {
            val = trueParam;
        }
        params[decodeURIComponent(paramParts[0])] = val;
    }
    return params;
}