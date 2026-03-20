import { NOCK_CONST } from "../core/constants.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class NockManagerApp extends HandlebarsApplicationMixin(ApplicationV2) {
    constructor(options = {}) {
        super(options);
        this.selectedId = null;
        this.selectedType = null;
    }
    static DEFAULT_OPTIONS = {
        id: "nock-nock-manager",
        tag: "form",
        window: {
            title: "Nock Nock: Радар и Настройки Замков",
            icon: "fas fa-key",
            resizable: true,
        },
        position: { width: 890, height: 650 },
        classes: ["nock-nock-app", "bg3-crafting-app"],
        actions: {
            selectTarget: this._onSelectTarget,
            pingTarget: this._onPingTarget,
            toggleLock: this._onToggleLock,
            saveSettings: this._onSaveSettings,
            removeKey: this._onRemoveKey
        }
    };
    static PARTS = {
        main: { template: "modules/nock-nock/templates/manager.hbs" }
    };

    _onRender(context, options) {
        super._onRender(context, options);
        
        const dropZones = this.element.querySelectorAll('[data-drop-zone="true"]');
        for (const zone of dropZones) {
            zone.addEventListener('dragover', this._onDragOver.bind(this));
            zone.addEventListener('drop', this._onDrop.bind(this));
        }
    }

    _onDragOver(event) {
        event.preventDefault(); 
        return false;
    }

    async _onDrop(event) {
        event.preventDefault(); 
        
        if (!this.selectedId) return;
        const data = TextEditor.getDragEventData(event);
        if (data.type !== "Item") {
            ui.notifications.warn("Nock Nock: Можно использовать только предметы!");
            return;
        }
        const item = await Item.implementation.fromDropData(data);
        if (!item) return;
        const doc = this._getDocument();
        if (!doc) return;
        const currentFlags = doc.getFlag(NOCK_CONST.MODULE_ID, NOCK_CONST.FLAGS.DATA) || {};
        currentFlags.key = {
            uuid: item.uuid,
            name: item.name,
            img: item.img
        };
        await doc.setFlag(NOCK_CONST.MODULE_ID, NOCK_CONST.FLAGS.DATA, currentFlags);
        ui.notifications.info(`Nock Nock: Ключ [${item.name}] успешно привязан!`);
        
        this.render({ force: true });
    }
    async _prepareContext(options) {
        const scene = canvas.scene;
        if (!scene) return { hasScene: false };

        const doors = canvas.walls.placeables
            .filter(w => w.document.door > 0)
            .map(w => ({
                id: w.id,
                name: `Дверь [x:${Math.round(w.x)}, y:${Math.round(w.y)}]`,
                isLocked: w.document.ds === CONST.WALL_DOOR_STATES.LOCKED,
                type: 'door',
                isSelected: this.selectedId === w.id
            }));

        const chests = canvas.tokens.placeables
            .filter(t => {
                if (!t.actor) return false;
                const isTHM = t.actor.flags?.["treasure-hoard-manager"]?.data;
                const isIP = t.actor.flags?.["item-piles"]?.data?.enabled;
                const isLoot = t.actor.type === "loot" || t.name.startsWith("Loot:");
                return isTHM || isIP || isLoot;
            })
            .map(t => {
                const isTHMLocked = t.actor.flags?.["treasure-hoard-manager"]?.data?.locked;
                const isIPLocked = t.actor.flags?.["item-piles"]?.data?.locked;
                return {
                    id: t.id,
                    name: t.name,
                    img: t.document.texture.src,
                    isLocked: isTHMLocked || isIPLocked || false,
                    type: 'token',
                    isSelected: this.selectedId === t.id
                };
            });

        if (!this.selectedId && (doors.length > 0 || chests.length > 0)) {
            const firstTarget = doors[0] || chests[0];
            this.selectedId = firstTarget.id;
            this.selectedType = firstTarget.type;
        }

        return {
            hasScene: true,
            doors: doors,
            chests: chests,
            hasTargets: doors.length > 0 || chests.length > 0,
            selected: this.selectedId ? this._getSelectedData() : null
        };
    }
    _getSelectedData() {
        let doc = this._getDocument();
        if (!doc) return null;

        const defaultSettings = {
            dc: 15,
            allowedStats: { str: false, dex: true, int: false },
            key: null 
        };

        const flags = doc.getFlag(NOCK_CONST.MODULE_ID, NOCK_CONST.FLAGS.DATA) || defaultSettings;

        return {
            id: doc.id,
            name: this.selectedType === 'door' ? "Дверь" : doc.name,
            type: this.selectedType,
            settings: flags
        };
    }
    _getDocument() {
        if (this.selectedType === 'door') return canvas.walls.get(this.selectedId)?.document;
        if (this.selectedType === 'token') return canvas.tokens.get(this.selectedId)?.actor;
        return null;
    }

    static async _onSelectTarget(event, target) {
        this.selectedId = target.dataset.id;
        this.selectedType = target.dataset.type;
        this.render({ force: true });
    }

    static async _onPingTarget(event, target) {
        event.stopPropagation();
        const id = target.dataset.id;
        const placeable = target.dataset.type === 'door' ? canvas.walls.get(id) : canvas.tokens.get(id);
        if (placeable) {
            await canvas.animatePan({ x: placeable.center.x, y: placeable.center.y, scale: 1.5 });
            canvas.ping(placeable.center);
        }
    }

    static async _onToggleLock(event, target) {
        event.stopPropagation();
        const id = target.dataset.id;
        const type = target.dataset.type;
        const isCurrentlyLocked = target.dataset.locked === "true";

        if (type === 'door') {
            const wallDoc = canvas.walls.get(id)?.document;
            if (wallDoc) {
                const newState = isCurrentlyLocked ? CONST.WALL_DOOR_STATES.CLOSED : CONST.WALL_DOOR_STATES.LOCKED;
                await wallDoc.update({ ds: newState });
            }
        } else if (type === 'token') {
            const actor = canvas.tokens.get(id)?.actor;
            if (actor) {
                const updates = {};
                if (actor.flags?.["item-piles"]?.data?.enabled) {
                    updates["flags.item-piles.data.locked"] = !isCurrentlyLocked;
                }
                if (actor.flags?.["treasure-hoard-manager"]?.data) {
                    updates["flags.treasure-hoard-manager.data.locked"] = !isCurrentlyLocked;
                }
                
                if (Object.keys(updates).length > 0) {
                    await actor.update(updates);
                }
            }
        }
        
        this.render({ force: true });
    }

    static async _onSaveSettings(event, target) {
        if (!this.selectedId) return;
        
        const doc = this._getDocument();
        if (!doc) return;

        const element = this.element;
        const dc = parseInt(element.querySelector("#nock-dc").value) || 15;
        const maxAttempts = parseInt(element.querySelector("#nock-attempts").value) || 0;
        const allowStr = element.querySelector("#nock-str").checked;
        const allowDex = element.querySelector("#nock-dex").checked;
        const allowInt = element.querySelector("#nock-int").checked;

        const currentFlags = doc.getFlag(NOCK_CONST.MODULE_ID, NOCK_CONST.FLAGS.DATA) || {};

        const newSettings = {
            ...currentFlags,
            dc: dc,
            maxAttempts: maxAttempts,
            failedAttempts: 0,
            allowedStats: { str: allowStr, dex: allowDex, int: allowInt }
        };

        await doc.setFlag(NOCK_CONST.MODULE_ID, NOCK_CONST.FLAGS.DATA, newSettings);
        ui.notifications.info("Nock Nock: Настройки замка успешно сохранены!");
    }

    static async _onRemoveKey(event, target) {
        const doc = this._getDocument();
        if (!doc) return;

        const currentFlags = doc.getFlag(NOCK_CONST.MODULE_ID, NOCK_CONST.FLAGS.DATA) || {};
        currentFlags.key = null;

        await doc.setFlag(NOCK_CONST.MODULE_ID, NOCK_CONST.FLAGS.DATA, currentFlags);
        ui.notifications.info("Nock Nock: Ключ удален из замка.");
        this.render({ force: true });
    }
}
