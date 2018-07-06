declare module "v4l2camera" {
    export type Camera = v4l2camera.Camera;
    export type Format = v4l2camera.Format;
}
declare module v4l2camera {
    export class Camera {
        public formats: Format[];
        constructor(v4l2Id: string);
        public configSet(format: Format): void;
        public configGet(): Format;
        public start(): void;
        public capture(callback: (success: boolean) => void): void;
        public frameRaw(): Uint8Array;
    }

    export type Format = {
        formatName: "MJPG"|"Unknown";
        /** This may be a char[4]. Not sure... */
        format: number;
        width: number;
        height: number;
        interval: { numerator: number, denominator: number };
    };
}