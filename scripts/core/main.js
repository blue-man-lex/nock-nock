import { NOCK_CONST } from "./constants.js";
import { NockManagerApp } from "../apps/nock-manager-app.js";
import { NockLockpickApp } from "../apps/nock-lockpick-app.js";

export let nockSocket = null;
let nockManagerApp = null;

Hooks.once('init', async function() {
    console.log(`${NOCK_CONST.MODULE_ID} | Инициализация...`);

    game.settings.register(NOCK_CONST.MODULE_ID, "successSound", {
        name: "Звук успешного взлома",
        hint: "Аудиофайл при успешном открытии замка",
        scope: "world",
        config: true,
        type: String,
        filePicker: "audio",
        default: "modules/nock-nock/sounds/success.mp3"
    });

    game.settings.register(NOCK_CONST.MODULE_ID, "failSound", {
        name: "Звук провала",
        hint: "Аудиофайл при неудачном броске",
        scope: "world",
        config: true,
        type: String,
        filePicker: "audio",
        default: "modules/nock-nock/sounds/fail.mp3"
    });

    game.settings.register(NOCK_CONST.MODULE_ID, "jamSound", {
        name: "Звук поломки/клина замка",
        hint: "Аудиофайл когда счетчик попыток дойдет до 0",
        scope: "world",
        config: true,
        type: String,
        filePicker: "audio",
        default: "modules/nock-nock/sounds/jam.mp3"
    });
});

async function _handleRecordFailure({ uuid }) {
    if (!game.user.isGM) return;
    const doc = await fromUuid(uuid);
    if (!doc) return;
    const flags = doc.getFlag(NOCK_CONST.MODULE_ID, NOCK_CONST.FLAGS.DATA) || {};
    const fails = (flags.failedAttempts || 0) + 1;
    await doc.setFlag(NOCK_CONST.MODULE_ID, NOCK_CONST.FLAGS.DATA, { ...flags, failedAttempts: fails });
}

Hooks.on("thm.preRenderInterface", (target, options) => {
    if (game.user.isGM) return true;

    const actor = target.actor || target;
    const isLocked = actor.getFlag("treasure-hoard-manager", "data.locked");

    if (isLocked) {
        console.log("Nock Nock | Перехват интерфейса THM через хук!");
        new NockLockpickApp(actor, 'token').render(true);
        return false;
    }
    return true;
});

Hooks.on("item-piles-preClickItemPile", (itemPile, interactingActor) => {
    if (game.user.isGM) return true;
    
    const actor = itemPile.actor || itemPile;
    const isLocked = actor.flags?.["item-piles"]?.data?.locked;

    if (isLocked) {
        console.log("Nock Nock | Перехват интерфейса Item Piles!");
        new NockLockpickApp(actor, 'token').render(true);
        return false; // Блокируем стандартное действие Item Piles
    }
    return true;
});

Hooks.on("item-piles-preRightClickItemPile", (itemPile, interactingActor) => {
    if (game.user.isGM) return true;
    const actor = itemPile.actor || itemPile;
    if (actor.flags?.["item-piles"]?.data?.locked) return false;
    return true;
});
Hooks.once('setup', () => {
    if (typeof libWrapper === "undefined") return;
    libWrapper.register(NOCK_CONST.MODULE_ID, 'DoorControl.prototype._onMouseDown', function(wrapped, event) {
        if (game.user.isGM || event.button !== 0) return wrapped(event);
        if (this.wall.document.ds === 2) {
            event.stopPropagation();
            new NockLockpickApp(this.wall.document, 'door').render(true);
            return false;
        }
        return wrapped(event);
    }, 'MIXED');
});
Hooks.once('ready', async function() {
    nockSocket = socketlib.registerModule(NOCK_CONST.MODULE_ID);
    nockSocket.register("requestUnlock", _handleUnlockRequest);
    nockSocket.register("recordFailure", _handleRecordFailure);
});

async function _handleUnlockRequest({ uuid }) {
    if (!game.user.isGM) return;
    
    const doc = await fromUuid(uuid);
    if (!doc) {
        console.error("Nock Nock | Объект для отпирания не найден:", uuid);
        return;
    }

    if (doc.documentName === "Wall") {
        await doc.update({ ds: 0 }); 
    } else {
        const updates = {};
        
        if (doc.flags?.["item-piles"]?.data?.enabled) {
            updates["flags.item-piles.data.locked"] = false;
        }
        if (doc.flags?.["treasure-hoard-manager"]?.data) {
            updates["flags.treasure-hoard-manager.data.locked"] = false;
        }
        
        if (Object.keys(updates).length > 0) {
            await doc.update(updates);
        }
        
        const successSound = game.settings.get(NOCK_CONST.MODULE_ID, "successSound");
        if (successSound) {
            foundry.audio.AudioHelper.play({ src: successSound, volume: 0.8 }, true);
        }
    }
}
Hooks.on("getSceneControlButtons", (controlButtons) => {
    if (!game.user.isGM) return;
    const tokensControl = controlButtons.tokens || Object.values(controlButtons).find(c => c.name === "token");
    if (!tokensControl) return;

    tokensControl.tools.nockNockManager = {
        name: "nockNockManager",
        title: "Nock Nock: Настройка",
        icon: "fas fa-unlock-alt",
        visible: true,
        button: true,
        onChange: () => { 
            if (!nockManagerApp) nockManagerApp = new NockManagerApp();
            nockManagerApp.render(true);
        }
    };
});
