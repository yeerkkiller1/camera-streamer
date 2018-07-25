let UID = Math.random();
let nextId = 0;
export function randomUID(prefix = "UID") {
    return prefix + (+new Date()).toString() + "." + (nextId++);
}