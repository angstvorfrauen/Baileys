//===================================//
import { SenderMessageKey } from './sender-message-key.js';
import { calculateMAC } from 'libsignal-xeuka/src/crypto.js';
//===================================//
export class SenderChainKey {
  constructor(iteration, chainKey) {
    this.MESSAGE_KEY_SEED = Buffer.from([0x01]);
    this.CHAIN_KEY_SEED = Buffer.from([0x02]);
    this.iteration = iteration;
    if (chainKey instanceof Buffer) {
      this.chainKey = chainKey;
    }
    else {
      this.chainKey = Buffer.from(chainKey || []);
    }
  }
  getIteration() {
    return this.iteration;
  }
  getSenderMessageKey() {
    return new SenderMessageKey(this.iteration, this.getDerivative(this.MESSAGE_KEY_SEED, this.chainKey));
  }
  getNext() {
    return new SenderChainKey(this.iteration + 1, this.getDerivative(this.CHAIN_KEY_SEED, this.chainKey));
  }
  getSeed() {
    return this.chainKey;
  }
  getDerivative(seed, key) {
    return calculateMAC(key, seed);
  }
}
//===================================//