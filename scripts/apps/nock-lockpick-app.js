import { NOCK_CONST } from "../core/constants.js";
import { nockSocket } from "../core/main.js";
const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
export class NockLockpickApp extends HandlebarsApplicationMixin(ApplicationV2) {
    constructor(targetDoc, type, options = {}) {
        super(options);
        this.targetDoc = targetDoc;
        this.type = type;
        this.selectedStat = "dex";
        this.bonusValue = ""; 
        this.advantage = 0;
    }
    static DEFAULT_OPTIONS = {
        id: "nock-lockpick-window",
        tag: "div",
        window: { title: "Взлом замка", resizable: false, controls: [] },
        position: { width: 500, height: "auto" },
        classes: ["nock-lockpick-app"],
        actions: {
            setStat: this._onSetStat,
            toggleAdvantage: this._onToggleAdvantage,
            rollDice: this._onRollDice,
            useKey: this._onUseKey
        }
    };
    static PARTS = {
        main: { template: "modules/nock-nock/templates/lockpick.hbs" }
    };
    _onRender(context, options) {
        super._onRender(context, options);
        const bonusInput = this.element.querySelector("#custom-bonus-text");
        if (bonusInput) {
            bonusInput.addEventListener("change", (e) => {
                this.bonusValue = e.target.value;
            });
        }
    }
    async _prepareContext(options) {
        const flags = this.targetDoc.getFlag(NOCK_CONST.MODULE_ID, NOCK_CONST.FLAGS.DATA) || { dc: 15 };
        const character = game.user.character;
        
        const allowedStats = flags.allowedStats || { str: false, dex: true, int: false };
        
        if (!allowedStats[this.selectedStat]) {
            if (allowedStats.dex) this.selectedStat = 'dex';
            else if (allowedStats.str) this.selectedStat = 'str';
            else if (allowedStats.int) this.selectedStat = 'int';
        }
        
        let hasKey = false;
        if (flags.key?.uuid && character) {
            hasKey = !!character.items.find(i => i.uuid === flags.key.uuid || i.name === flags.key.name);
        }
        let statMod = 0;
        let toolBonus = 0;
        let toolName = null;
        if (character) {
            statMod = character.system.abilities[this.selectedStat]?.mod || 0;
            
        
            const lockpickTool = character.items.find(i => 
                i.name.toLowerCase().includes("вора") || 
                i.name.toLowerCase().includes("thiev") ||
                i.system.toolType === "thief"
            );

            if (lockpickTool) {
                toolName = lockpickTool.name;
                
                toolBonus = character.system.attributes.prof || 0;
            }
        }
        let numericCustomBonus = 0;
        let customFormulaDisplay = "";
        if (this.bonusValue) {
            try {
                if (this.bonusValue.toLowerCase().match(/[dд]/)) {
                    customFormulaDisplay = this.bonusValue.trim();
                } else {
                    numericCustomBonus = Roll.safeEval(this.bonusValue) || 0;
                }
            } catch (err) {
                customFormulaDisplay = this.bonusValue.trim();
            }
        }
        let baseTotal = statMod + toolBonus + numericCustomBonus;
        let displayTotal = customFormulaDisplay ? `${baseTotal > 0 ? baseTotal + ' + ' : ''}${customFormulaDisplay}` : baseTotal;
        
        const maxAttempts = flags.maxAttempts || 0;
        const failedAttempts = flags.failedAttempts || 0;
        let remaining = "∞";
        let isJammed = false;
        
        if (maxAttempts > 0) {
            remaining = Math.max(0, maxAttempts - failedAttempts);
            isJammed = remaining === 0;
        }
        
        return {
            flags: flags,
            allowedStats: allowedStats,
            targetName: this.type === 'door' ? "Дверь" : this.targetDoc.name,
            hasKey: hasKey,
            keyData: flags.key,
            selectedStat: this.selectedStat,
            statMod: statMod,
            toolBonus: toolBonus,
            toolName: toolName,
            bonusValue: this.bonusValue,
            numericCustomBonus: numericCustomBonus,
            customFormulaDisplay: customFormulaDisplay,
            displayTotal: displayTotal,
            advantage: this.advantage,
            remainingAttempts: remaining,
            isJammed: isJammed
        };
    }
    static _onSetStat(event, target) {
        this.selectedStat = target.dataset.stat;
        this.render(true);
    }
    static _onToggleAdvantage(event, target) {
        this.advantage = parseInt(target.dataset.val);
        this.render(true);
    }
    static async _onUseKey() {
        ui.notifications.info("Вы использовали ключ...");
        await nockSocket.executeAsGM("requestUnlock", { uuid: this.targetDoc.uuid });
        this.close();
    }
    static async _onRollDice(event, target) {
        const flags = this.targetDoc.getFlag(NOCK_CONST.MODULE_ID, NOCK_CONST.FLAGS.DATA) || { dc: 15 };
        
        const maxAttempts = flags.maxAttempts || 0;
        const failedAttempts = flags.failedAttempts || 0;
        if (maxAttempts > 0 && failedAttempts >= maxAttempts) {
            ui.notifications.error("Замок заклинило! Больше попыток нет.");
            return;
        }

        const circle = this.element.querySelector(".roll-circle");
        circle.classList.add("nock-shake");
        await new Promise(r => setTimeout(r, 400));
        circle.classList.remove("nock-shake");
        
        const context = await this._prepareContext();
        let formula = "1d20";
        if (this.advantage === 1) formula = "2d20kh1";
        if (this.advantage === -1) formula = "2d20kl1";
        
        let finalFormula = `${formula} + ${context.statMod} + ${context.toolBonus}`;
        if (this.bonusValue) finalFormula += ` + ${this.bonusValue}`;
        
        const roll = await new Roll(finalFormula).evaluate();
        
        const success = roll.total >= flags.dc;
        
        let attemptsText = "";
        if (!success && maxAttempts > 0) {
            const newRemaining = Math.max(0, maxAttempts - (failedAttempts + 1));
            if (newRemaining === 0) {
                attemptsText = "<br><span style='color: #e84118; font-weight: bold;'>⚠️ ЗАМОК ЗАКЛИНИЛО!</span>";
            } else {
                attemptsText = `<br><span style='color: #000000ff;'>Осталось попыток: ${newRemaining}</span>`;
            }
        }

        const flavor = `
            <div style="text-align: center; border: 2px solid ${success ? '#4cd137' : '#e84118'}; border-radius: 8px; padding: 10px; background: rgba(0,0,0,0.1); box-shadow: inset 0 0 10px ${success ? 'rgba(76, 209, 55, 0.2)' : 'rgba(232, 65, 24, 0.2)'};">
                <h3 style="margin: 0; color: ${success ? '#4cd137' : '#e84118'}; text-transform: uppercase; letter-spacing: 2px;">
                    ${success ? '<i class="fas fa-unlock"></i> УСПЕХ' : '<i class="fas fa-lock"></i> ПРОВАЛ'}
                </h3>
                <div style="font-size: 0.85em; color: #888; margin-top: 5px;">
                    Цель: ${this.type === 'door' ? 'Дверь' : this.targetDoc.name} (DC ${flags.dc})
                    ${attemptsText}
                </div>
            </div>
        `;
        
        await roll.toMessage({
            speaker: ChatMessage.getSpeaker({actor: game.user.character}),
            flavor: flavor
        });
        
        if (success) {
            ui.notifications.info(`Успех! Результат: ${roll.total}`);
            await nockSocket.executeAsGM("requestUnlock", { uuid: this.targetDoc.uuid });
            this.close();
        } else {
            ui.notifications.error("Слишком сложно...");
            
            // Проверяем, стала ли эта попытка последней
            const isNowJammed = maxAttempts > 0 && (failedAttempts + 1) >= maxAttempts;
            
            if (isNowJammed) {
            } else {
                const failSound = game.settings.get(NOCK_CONST.MODULE_ID, "failSound");
                if (failSound) {
                    const audio = new Audio(failSound);
                    audio.volume = 0.6;
                    audio.addEventListener('canplaythrough', () => audio.play());
                    audio.addEventListener('error', (e) => console.error("Nock Nock | Fail sound error:", e));
                    audio.load();
                }
            }

            // Фиксируем провал через сокет
            await nockSocket.executeAsGM("recordFailure", { uuid: this.targetDoc.uuid });
            
            // Проверяем клинил ли замок после этой попытки
            const newFlags = this.targetDoc.getFlag(NOCK_CONST.MODULE_ID, NOCK_CONST.FLAGS.DATA) || {};
            const newFailedAttempts = newFlags.failedAttempts || 0;
            const isNowJammedAfter = maxAttempts > 0 && newFailedAttempts >= maxAttempts;
            
            // Перерисовываем UI чтобы обновить счетчик и показать клин
            this.render(true);
            
            if (isNowJammedAfter) {
                // Замок только что клинил - играем звук КЛИНА
                const jamSound = game.settings.get(NOCK_CONST.MODULE_ID, "jamSound");
                if (jamSound) {
                    const audio = new Audio(jamSound);
                    audio.volume = 0.8;
                    audio.addEventListener('canplaythrough', () => audio.play());
                    audio.addEventListener('error', (e) => console.error("Nock Nock | Jam sound error:", e));
                    audio.load();
                }
            }
        }
    }
}
