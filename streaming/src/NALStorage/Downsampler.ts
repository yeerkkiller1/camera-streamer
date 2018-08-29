import { isInteger } from "../util/type";

type DownsampleCtorT<T extends Ctor<DownsampledInstance>> = FirstArg<UnwrapCtor<T>["AddValue"]>;
export interface DownsampledInstance<T = any> {
    Rate: number;
    AddValue(val: T): Promise<void>|void;
    DroppedValue?: (val: T) => Promise<void>|void;
}
export class Downsampler<T extends new(rate: number) => DownsampledInstance<any>> {
    constructor(
        public readonly BaseRate: number,
        private RateClass: T,
        /** How many values exist already. This influences when we create new rates
         *      and when we add to rates.
         */
        private valueCount: number = 0
    ) {
        if(this.BaseRate < 2) {
            throw new Error(`BaseRate < 2 is not supported. Very low values (1.1) would cause issues with how we store rate (as a number, instead of an exponent). Anything <= 1 is also invalid, causing infinite upsampling.`);
        }
        if(!isInteger(this.BaseRate)) {
            throw new Error(`BaseRate must be an integer. It was ${this.BaseRate}`);
        }

        let maxLogRate = this.getRate(this.valueCount);

        let rate = 1;
        while(rate < maxLogRate) {
            if(!(rate in this.rateInstances)) {
                this.rateInstances[rate] = { instance: new this.RateClass(rate) };
            }
            rate *= this.BaseRate;
        }
    }

    // Even at a BaseRate of 2 this will still take an insane amount of data to grow too big.
    private rateInstances: { [rate: number]: { instance: DownsampledInstance<any>; } } = { };

    public GetCount() {
        return this.valueCount;
    }

    private getRate(count: number) {
        return Math.pow(this.BaseRate, Math.floor(Math.log(count) / Math.log(this.BaseRate)));
    }
    public async AddValue(val: DownsampleCtorT<T>): Promise<void> {
        let curCount = ++this.valueCount;
        let maxLogRate = this.getRate(curCount);
        if(!(maxLogRate in this.rateInstances)) {
            this.rateInstances[maxLogRate] = { instance: new this.RateClass(maxLogRate) };
        }

        for(let rateStr in this.rateInstances) {
            let rate = +rateStr;

            let obj = this.rateInstances[rateStr];
            let instance = obj.instance;
            let triggered = (curCount % rate) === 0;
            if(triggered) {
                await instance.AddValue(val);
            } else {
                // Optional, so in theory we could optimize this loop to only iterate over the rateInstances for this value from the get go.
                //  But... I don't think I will every make that optimization, as how many values will I really have? 2^32? That's 4GB. 2^42 ? That's 4TB,
                //  and even 2^42 only loops 42 times.
                if(instance.DroppedValue) {
                    await instance.DroppedValue(val);
                }
            }
        }
    }

    public GetInstance(maxCount: number): UnwrapCtor<T> {
        let rate = Math.ceil(this.valueCount / maxCount);
        // Rate cannot be higher than the max rate.
        rate = Math.min(rate, this.getRate(this.valueCount));
        // Now round rate up to the nearest factor of 2.
        rate = Math.pow(this.BaseRate, Math.ceil(Math.log(rate) / Math.log(this.BaseRate)));
        return this.rateInstances[rate].instance as UnwrapCtor<T>;
    }

    public GetInstanceRate(rate: number): UnwrapCtor<T> {
        return this.rateInstances[rate].instance as UnwrapCtor<T>;
    }

    public GetRates(): number[] {
        return Object.keys(this.rateInstances).map(x => +x);
    }
}