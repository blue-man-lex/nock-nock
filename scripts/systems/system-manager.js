import { Dnd5eAdapter } from './dnd5e-adapter.js';
import { CyberpunkRedAdapter } from './cpr-adapter.js';
import { SystemAdapter } from './system-adapter.js';

export class SystemManager {
    static adapter = null;

    static init() {
        const systemId = game.system.id;
        console.log(`Nock Nock | Определение системы: ${systemId}`);

        switch (systemId) {
            case "dnd5e":
                this.adapter = new Dnd5eAdapter();
                break;
            case "cyberpunk-red-core":
                this.adapter = new CyberpunkRedAdapter();
                break;
            default:
                this.adapter = new SystemAdapter();
                break;
        }
    }

    static get() {
        if (!this.adapter) this.init();
        return this.adapter;
    }
}
