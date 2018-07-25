import * as React from "react";

import "./PixelGraph.less";
import { max } from "./math";

// https://stackoverflow.com/questions/2353211/hsl-to-rgb-color-conversion
function hslToRgb(h: number, s: number, l: number) {
    var r, g, b;
    h /= 360;

    if (s == 0) {
        r = g = b = l; // achromatic
    } else {
        var hue2rgb = function hue2rgb(p: number, q: number, t: number) {
            if(t < 0) t += 1;
            if(t > 1) t -= 1;
            if(t < 1/6) return p + (q - p) * 6 * t;
            if(t < 1/2) return q;
            if(t < 2/3) return p + (q - p) * (2/3 - t) * 6;
            return p;
        }

        var q = l < 0.5 ? l * (1 + s) : l + s - l * s;
        var p = 2 * l - q;
        r = hue2rgb(p, q, h + 1/3);
        g = hue2rgb(p, q, h);
        b = hue2rgb(p, q, h - 1/3);
    }

    return {r: Math.round(r * 255), b: Math.round(g * 255), g: Math.round(b * 255)};
}

export type Color = { h: number; s: number; l: number; a: number; };
export class PixelGraph extends React.Component<
    {
        minY: number;
        maxY: number;
        lines: {
            color: Color;
            data: number[];
        }[];
        heightInPixels: number;

        lineWidth: number;
    },
    { }
> {
    renderCanvas(canvasElement: HTMLCanvasElement|null) {
        if(!canvasElement) return;
        let context = canvasElement.getContext("2d", {});
        if(!context) return;

        //TODO:
        // Make the lines bigger. Probably stop doing it a pixel level and start using canvas.
        //  Also add an automatic key.
        //  And... do something about overlapping lines?

        let { minY, maxY, lines, heightInPixels, lineWidth } = this.props;
        
        let widthInPixels = max(lines.map(x => x.data.length)) * lineWidth;

        let imageData = context.createImageData(widthInPixels, heightInPixels);
        let img = imageData.data;        

        /** https://developer.mozilla.org/en-US/docs/Web/API/Canvas_API/Tutorial/Pixel_manipulation_with_canvas */
        function getIndex(x: number, y: number) {
            return y * (widthInPixels * 4) + x * 4;
        }
        //rgba
        for(let line of lines) {
            let color = hslToRgb(line.color.h, line.color.s, line.color.l);
            let a = line.color.a;
            for(let i = 0; i < line.data.length; i++) {
                let yValue = line.data[i];
                let y = Math.round((yValue - minY) / (maxY - minY) * heightInPixels);

                for(let xOff = 0; xOff < lineWidth; xOff++) {
                    let x = i * lineWidth + xOff;
                    let index = getIndex(x, y);
                    img[index] = color.r;
                    img[index + 1] = color.g;
                    img[index + 2] = color.b;
                    img[index + 3] = Math.round(a * 255);
                }
            }
        }
        context.putImageData(imageData, 0, 0);
    }
    render() {
        return (
            <canvas
                className="PixelGraph"
                width={max(this.props.lines.map(x => x.data.length)) * this.props.lineWidth}
                height={this.props.heightInPixels}
                ref={x => this.renderCanvas(x)}
            />
        )
    }
}