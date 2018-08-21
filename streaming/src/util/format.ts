export function formatDuration(ms: number) {
    let s = ms / 1000;
    let m = s / 60;
    let h = m / 60;
    let d = h / 24;

    ms = Math.floor(ms % 1000);
    s = Math.floor(s % 60);
    m = Math.floor(m % 60);
    h = Math.floor(h % 24);
    d = Math.floor(d);

    let parts: string[] = [];
    parts.push(`${d}d`);
    parts.push(`${h}h`);
    parts.push(`${m}m`);
    parts.push(`${s}s`);
    parts.push(`${ms}ms`);

    (() => {
        if(d !== 0) return;
        parts.shift();
        if(h !== 0) return;
        parts.shift();
        if(m !== 0) return;
        parts.shift();
        if(s !== 0) return;
        parts.shift();
    })();

    parts = parts.slice(0, 2);

    return parts.join(" ");
}

export const shortMonthsList = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function formatDate(time: number): string {
    let d = new Date(time);
    
    let day = d.getDate();
    let month = shortMonthsList[d.getMonth()];
    let year = d.getFullYear();

    let hours = d.getHours();
    let mins = d.getMinutes();
    let seconds = d.getSeconds();

    let p = (x: number) => x < 10 ? "0" + x : x.toString();

    let hourPeriod = hours < 12 ? "am" : "pm";
    if(hours >= 12) {
        hours -= 12;
    }
    if(hours === 0) {
        hours = 12;
    }

    return `${year} ${month} ${day}  ${p(hours)}:${p(mins)}:${p(seconds)} ${hourPeriod}`;
}