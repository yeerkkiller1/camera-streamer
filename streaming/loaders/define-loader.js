module.exports = function(source) {
    //console.log(`Parsing source of length ${source.length}, starts with ${source.slice(0, 200)}`);
    let paramsRaw = this.query.slice(1).split("&");
    let params = {};
    for(var i = 0; i < paramsRaw.length; i++) {
        let paramRaw = paramsRaw[i];
        let paramParts = paramRaw.split("=");
        params[decodeURIComponent(paramParts[0])] = decodeURIComponent(paramParts[1]);
    }

    var node = params["node"] === "true";

    if (!node) {
        let i = 0;

        while (true) {
            i = source.indexOf("NODE_CONSTANT", i);
            if(i < 0) break;

            i = source.indexOf("{", i);
            if(i < 0) break;

            let start = i;
            i++;

            let nestLevel = 1;
            while (nestLevel > 0 && i < source.length) {
                var ch = source[i++];
                if(ch === "{") {
                    nestLevel++;
                } else if(ch === "}") {
                    nestLevel--;
                }
            }

            source = source.slice(0, start + 1) + source.slice(i - 1);
            i = start + 2;
        }
    }

    /*
    for(var key in params) {
        source = source.replace(new RegExp(key, "g"), params[key]);
    }
    */

    return source;
};