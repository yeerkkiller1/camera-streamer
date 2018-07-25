import * as Jimp from "jimp";

export async function createSimulatedFrame(time: number, width: number, height: number): Promise<Buffer> {
    let jimpAny = Jimp as any;

    async function loadFont(type: string): Promise<any> {
        return new Promise((resolve, reject) => {
            jimpAny.loadFont(type, (err: any, font: any) => {
                err ? reject(err) : resolve(font);
            });
        });
    }

    let image: any;
    image = new jimpAny(width, height, 0xFF00FFFF, () => {});
    
    image.resize(width, height);

    let data: Buffer = image.bitmap.data;
    let frameNumber = ~~time;
    for(let i = 0; i < width * height; i++) {
        let k = i * 4;
        let seed = (frameNumber + 1) * i;
        data[k] = seed % 256;
        data[k + 1] = (seed * 67) % 256;
        data[k + 2] = (seed * 679) % 256;
        data[k + 3] = 255;

        data[k] = 50;
        data[k + 1] = 50;
        data[k + 2] = 50;
    }

    let imageColor = new jimpAny(width, 64, 0x000000AF, () => {});
    image.composite(imageColor, 0, 0);

    let path = "./node_modules/jimp/fonts/open-sans/open-sans-64-white/open-sans-64-white.fnt";
    let font = await loadFont(path);
    image.print(font, 0, 0, `frame time ${time.toFixed(2)}ms`, width);
    
    let jpegBuffer!: Buffer;
    image.quality(75).getBuffer(Jimp.MIME_JPEG, (err: any, buffer: Buffer) => {
        if(err) throw err;
        jpegBuffer = buffer;
    });

    return jpegBuffer;
}