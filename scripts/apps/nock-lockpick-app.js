import { NOCK_CONST } from "../core/constants.js";
import { nockSocket } from "../core/main.js";
import { SystemManager } from "../systems/system-manager.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class NockLockpickApp extends HandlebarsApplicationMixin(ApplicationV2) {
    constructor(targetDoc, type, options = {}) {
        super(options);
        this.targetDoc = targetDoc;
        this.type = type;
        
        // Получаем адаптер
        const adapter = SystemManager.get();
        
        // Умный поиск актера: сначала назначенный персонаж, затем выбранный токен
        this.actor = game.user.character || canvas.tokens.controlled[0]?.actor;
        
        const actorData = adapter.getActorData(this.actor);
        this.selectedStat = actorData.stats[0]?.id || "pickLock";
        
        this.bonusValue = ""; 
        this.advantage = 0;
        this.isJammed = false;

        // --- СОСТОЯНИЕ МИНИ-ИГР ---
        this.activeMode = null; // 'cylinder' | 'pins' | 'dice' | 'dials'
        
        // 1. Механический цилиндр (Skyrim)
        this.pickAngle = 0; // угол отмычки от -85 до +85 градусов
        this.cylinderAngle = 0; // текущий угол поворота замка (0 - 90)
        this.currentCylinderStage = 0;
        this.cylinderStages = [90];
        this.stageSweetSpots = [0];
        this.sweetSpotAngle = 0;
        this.sweetSpotTolerance = 8;
        this.pickStrain = 0; // текущее напряжение шпильки (0 - 100%)
        this.isTurningCylinder = false;
        this._cylinderInterval = null;
        this._cylinderInitialized = false;

        // 2. Штифтовой замок (Oblivion)
        this.activePinIndex = 0;
        this._pinsInitialized = false;
        this.pins = [];
        this.isPushingPin = false;
        this._pinRiseInterval = null;
        this.pinSpeed = 2.5;
        this.pinTolerance = 6;

        // 3. Дисковый криптекс (Dials / Rings)
        this.activeDialIndex = 0;
        this._dialsInitialized = false;
        this.dials = [];
        this.dialTension = 100;
        this.dialDrainPerDegree = 0.2;
        this._dialTensionInterval = null;

        // Хэндлер клавиатуры
        this._boundKeyHandler = this._onKeyDown.bind(this);
        this._boundKeyUpHandler = this._onKeyUp.bind(this);
        this._boundStopCylinder = this._stopCylinderTurn.bind(this);
    }

    static DEFAULT_OPTIONS = {
        id: "nock-lockpick-window",
        tag: "div",
        window: { title: "Взлом замка", resizable: false, controls: [] },
        position: { width: 540, height: "auto" },
        classes: ["nock-lockpick-app"],
        actions: {
            setStat: this._onSetStat,
            toggleAdvantage: this._onToggleAdvantage,
            rollDice: this._onRollDice,
            useKey: this._onUseKey,
            switchMode: this._onSwitchMode,
            selectDial: this._onSelectDial
        }
    };

    static PARTS = {
        main: { template: "modules/nock-nock/templates/lockpick.hbs" }
    };

    _onRender(context, options) {
        super._onRender(context, options);

        // Инпут кастомного бонуса
        const bonusInput = this.element.querySelector("#custom-bonus-text");
        if (bonusInput) {
            bonusInput.addEventListener("input", (e) => {
                this.bonusValue = e.target.value;
                const dc = SystemManager.get().getDC(this.targetDoc);
                this._updateTolerances(dc);
            });
            bonusInput.addEventListener("change", (e) => {
                this.bonusValue = e.target.value;
                this.render({ force: true });
            });
            bonusInput.addEventListener("keydown", (e) => {
                if (e.key === "Enter") {
                    e.preventDefault();
                    this.bonusValue = e.target.value;
                    this.render({ force: true });
                }
            });
        }

        // Подключение слушателей клавиатуры
        document.removeEventListener("keydown", this._boundKeyHandler);
        document.removeEventListener("keyup", this._boundKeyUpHandler);
        document.addEventListener("keydown", this._boundKeyHandler);
        document.addEventListener("keyup", this._boundKeyUpHandler);

        // --- ИНИЦИАЛИЗАЦИЯ ИНТЕРАКТИВА ЦИЛИНДРА ---
        if (this.activeMode === 'cylinder') {
            this._setupCylinderEvents();
        }

        // --- ИНИЦИАЛИЗАЦИЯ ИНТЕРАКТИВА ШТИФТОВ ---
        if (this.activeMode === 'pins') {
            this._setupPinsEvents();
        }

        // --- ИНИЦИАЛИЗАЦИЯ ИНТЕРАКТИВА ДИСКОВ (КРИПТЕКС) ---
        if (this.activeMode === 'dials') {
            this._setupDialsEvents();
        }
    }

    /**
     * Детерминированный генератор псевдослучайных чисел на основе ID документа
     * Гарантирует постоянную комбинацию замка без ошибок прав записи у игроков
     */
    _getSeededRng(subKey = "") {
        const seedStr = `${this.targetDoc?.id || "lock"}_${subKey}`;
        let hash = 0;
        for (let i = 0; i < seedStr.length; i++) {
            hash = (Math.imul(31, hash) + seedStr.charCodeAt(i)) | 0;
        }
        return function() {
            hash = (Math.imul(48271, hash) + 12345) | 0;
            return ((hash >>> 0) % 1000000) / 1000000;
        };
    }

    /**
     * Динамический расчет эффективного суммарного бонуса (характеристика + инструменты + ручной бонус/кубик)
     */
    _getEffectiveBonus() {
        const adapter = SystemManager.get();
        const actorData = adapter.getActorData(this.actor);
        const currentStat = actorData.stats.find(s => s.id === this.selectedStat);
        const statMod = currentStat?.mod || 0;
        const toolBonus = actorData.toolBonus || 0;
        let customNum = 0;
        if (this.bonusValue) {
            const trimmed = String(this.bonusValue).trim().toLowerCase();
            const matchDice = trimmed.match(/^(\d*)d(\d+)/i) || trimmed.match(/^(\d*)д(\d+)/i);
            if (matchDice) {
                const count = parseInt(matchDice[1]) || 1;
                const sides = parseInt(matchDice[2]) || 4;
                customNum = count * ((sides + 1) / 2);
            } else {
                try {
                    const clean = trimmed.replace(/^\+/, '');
                    customNum = Roll.safeEval(clean) || 0;
                } catch (e) {
                    customNum = parseFloat(trimmed) || 0;
                }
            }
        }
        const total = statMod + toolBonus + customNum;
        return { statMod, toolBonus, customBonus: customNum, total };
    }

    /**
     * Динамическая калибровка допусков и параметров всех мини-игр в реальном времени под текущие бонусы
     */
    _updateTolerances(dc) {
        const bonus = this._getEffectiveBonus();

        // 1. ЦИЛИНДР И ОТМЫЧКА (Skyrim):
        // Допустимая погрешность угла (сектор отмычки)
        const cylStatBonus = bonus.total * 0.45;
        this.sweetSpotTolerance = Math.max(5.0, Math.min(18.0, 13.5 - (dc * 0.28) + cylStatBonus));
        // Скорость нарастания напряжения (чем выше бонус, тем медленнее ломается)
        this.strainRate = Math.max(1.0, 2.8 - (bonus.total * 0.12));

        // 2. ШТИФТОВОЙ ЗАМОК (Oblivion):
        // Окно фиксации штифта по высоте линии среза
        const pinStatBonus = Math.max(0, bonus.total * 0.45);
        this.pinTolerance = Math.max(8.0, Math.min(20.0, 14.0 - (dc * 0.22) + pinStatBonus));
        // Плавность подъема штифта
        const statDamp = Math.max(0, bonus.total * 0.035);
        this.pinSpeed = Math.max(0.65, Math.min(1.35, 0.85 + (dc * 0.018) - statDamp));

        // 3. ДИСКОВЫЙ КРИПТЕКС (Dials):
        // Сектор совпадения руны/паза
        const dialStatBonus = Math.max(0, bonus.total * 0.35);
        this.dialTolerance = Math.max(4.0, Math.min(14.0, 8.5 - (dc * 0.20) + dialStatBonus));
        if (Array.isArray(this.dials)) {
            for (const d of this.dials) {
                d.tolerance = this.dialTolerance;
            }
        }
        // Расход завода пружины на градус вращения
        this.dialDrainPerDegree = Math.max(0.06, Math.min(0.40, (0.08 + (dc * 0.011)) - (bonus.total * 0.010)));
    }

    /**
     * Инициализация этапов поворота замка и скрытых секторов сувальд под сложность (DC)
     */
    _initCylinderData(dc) {
        if (this._cylinderInitialized) return;
        this._cylinderInitialized = true;

        this._updateTolerances(dc);

        // Определение этапов сувальд (фаз) в зависимости от сложности:
        // DC <= 14: 1 фаза (90°)
        // DC 15-24: 2 фазы (45°, 90°)
        // DC >= 25: 3 фазы (30°, 60°, 90°)
        if (dc >= 25) {
            this.cylinderStages = [30, 60, 90];
        } else if (dc >= 15) {
            this.cylinderStages = [45, 90];
        } else {
            this.cylinderStages = [90];
        }

        // Постоянная комбинация углов для этого конкретного замка
        const flags = this.targetDoc.getFlag(NOCK_CONST.MODULE_ID, NOCK_CONST.FLAGS.DATA) || {};
        let savedSpots = flags.cylinderSweetSpots;
        if (!Array.isArray(savedSpots) || savedSpots.length !== this.cylinderStages.length) {
            const rng = this._getSeededRng("cylinder");
            savedSpots = [];
            let lastAngle = null;
            for (let i = 0; i < this.cylinderStages.length; i++) {
                let nextAngle;
                let attempts = 0;
                do {
                    nextAngle = Math.round((rng() * 130) - 65); // от -65 до +65
                    attempts++;
                } while (lastAngle !== null && Math.abs(nextAngle - lastAngle) < 30 && attempts < 30);
                savedSpots.push(nextAngle);
                lastAngle = nextAngle;
            }
            if (game.user.isGM) {
                this.targetDoc.setFlag(NOCK_CONST.MODULE_ID, `${NOCK_CONST.FLAGS.DATA}.cylinderSweetSpots`, savedSpots);
            }
        }

        this.stageSweetSpots = savedSpots;
        this.currentCylinderStage = 0;
        this.sweetSpotAngle = this.stageSweetSpots[0];
        this.cylinderAngle = 0;
        this.pickStrain = 0;
    }

    /**
     * Инициализация ломаной линии среза (Shear Line) и штифтов под сложность (DC)
     */
    _initPinsData(dc) {
        if (this._pinsInitialized) return;
        this._pinsInitialized = true;

        // Количество штифтов зависит от DC:
        // DC <= 14: 3 штифта
        // DC 15-24: 4 штифта
        // DC >= 25: 5 штифтов
        let pinCount = 4;
        if (dc >= 25) pinCount = 5;
        else if (dc <= 14) pinCount = 3;

        const arenaWidth = 408;
        const chamberCenters = [];
        const colWidth = arenaWidth / pinCount;
        for (let i = 0; i < pinCount; i++) {
            chamberCenters.push(Math.round((i + 0.5) * colWidth));
        }

        this._updateTolerances(dc);

        // Постоянная конфигурация штифтов для этого конкретного замка
        const flags = this.targetDoc.getFlag(NOCK_CONST.MODULE_ID, NOCK_CONST.FLAGS.DATA) || {};
        let savedPins = flags.pinsConfig;
        if (!Array.isArray(savedPins) || savedPins.length !== pinCount) {
            const rng = this._getSeededRng("pins");
            savedPins = [];
            const heightPresets = [50, 84, 60, 92, 68];
            for (let i = 0; i < pinCount; i++) {
                const kh = heightPresets[i % heightPresets.length];
                const restSplitY = 225 - kh;
                // Высота среза (Shear Line) с учетом разной начальной высоты
                const liftNeeded = Math.round(35 + rng() * 35); // 35..70px
                const targetShearY = restSplitY - liftNeeded;
                savedPins.push({ keyHeight: kh, targetShearY: targetShearY, targetLift: liftNeeded });
            }
            if (game.user.isGM) {
                this.targetDoc.setFlag(NOCK_CONST.MODULE_ID, `${NOCK_CONST.FLAGS.DATA}.pinsConfig`, savedPins);
            }
        }

        this.pins = chamberCenters.map((cx, idx) => {
            const cfg = savedPins[idx];
            const keyRestTop = 225 - cfg.keyHeight;
            const driverRestTop = keyRestTop - 60;
            return {
                id: idx,
                centerX: cx,
                keyHeight: cfg.keyHeight,
                keyRestTop: keyRestTop,
                driverRestTop: driverRestTop,
                targetShearY: cfg.targetShearY,
                targetLift: cfg.targetLift,
                currentLift: 0,
                isLocked: false
            };
        });

        this.activePinIndex = 0;
    }

    /**
     * Инициализация концентрических дисков криптекса под сложность (DC)
     */
    _initDialsData(dc) {
        if (this._dialsInitialized) return;
        this._dialsInitialized = true;

        let count = 3;
        if (dc >= 26) count = 5;
        else if (dc >= 16) count = 4;

        this._updateTolerances(dc);

        // Постоянная секретная комбинация пазов для этого конкретного замка
        const flags = this.targetDoc.getFlag(NOCK_CONST.MODULE_ID, NOCK_CONST.FLAGS.DATA) || {};
        let dialComb = flags.dialsCombination;
        if (!Array.isArray(dialComb) || dialComb.length !== count) {
            const rng = this._getSeededRng("dials");
            dialComb = [];
            for (let i = 0; i < count; i++) {
                dialComb.push(Math.floor(rng() * 360));
            }
            if (game.user.isGM) {
                this.targetDoc.setFlag(NOCK_CONST.MODULE_ID, `${NOCK_CONST.FLAGS.DATA}.dialsCombination`, dialComb);
            }
        }

        this.dials = [];
        for (let i = 0; i < count; i++) {
            let label = `Кольцо ${i + 1}`;
            if (count === 3) {
                if (i === 0) label = "Кольцо 1 (Крупное)";
                else if (i === 1) label = "Кольцо 2 (Среднее)";
                else if (i === 2) label = "Кольцо 3 (Малое)";
            } else if (count === 4) {
                if (i === 0) label = "Кольцо 1 (Внешнее)";
                else if (i === 3) label = "Кольцо 4 (Внутреннее)";
            } else {
                if (i === 0) label = "Кольцо 1 (Внешнее)";
                else if (i === 4) label = "Кольцо 5 (Внутреннее)";
            }

            let texture = `modules/nock-nock/assets/dial_ring_${i + 1}.png`;
            if (count === 3) texture = `modules/nock-nock/assets/dial_3_ring_${i + 1}.png`;
            else if (count === 4) texture = `modules/nock-nock/assets/dial_4_ring_${i + 1}.png`;

            const catchAngle = dialComb[i];
            
            // Начальный угол ставим со смещением от паза
            const startAngle = (catchAngle + 120 + ((i + 1) * 35)) % 360;

            this.dials.push({
                index: i,
                ringNumber: i + 1,
                label: label,
                texture: texture,
                currentAngle: startAngle,
                catchAngle: catchAngle,
                tolerance: this.dialTolerance,
                isLocked: false
            });
        }

        this.dialTension = 100;
        this.activeDialIndex = 0;
    }

    /**
     * Срыв завода пружины при исчерпании ресурса
     */
    async _onDialsExhaustion() {
        ui.notifications.warn("Завод механизма исчерпан! Пружина криптекса сорвалась.");
        this.dialTension = 100;

        const flags = this.targetDoc.getFlag(NOCK_CONST.MODULE_ID, NOCK_CONST.FLAGS.DATA) || {};
        const maxAttempts = flags.maxAttempts || 0;
        const nextFails = (flags.failedAttempts || 0) + 1;

        if (maxAttempts > 0 && nextFails >= maxAttempts) {
            this.isJammed = true;
            this._triggerJammedReaction();
        } else {
            const failSound = game.settings.get(NOCK_CONST.MODULE_ID, "failSound");
            if (failSound) foundry.audio.AudioHelper.play({ src: failSound, volume: 0.7 }, true);
        }

        await nockSocket.executeAsGM("recordFailure", { uuid: this.targetDoc.uuid });
        
        // Сброс дисков: сохраняем секретную комбинацию замка, чтобы игрок мог запомнить и быстрее найти углы!
        this.dials.forEach((d, idx) => {
            d.isLocked = false;
            d.isAligned = false;
            d.currentAngle = (d.catchAngle + 120 + ((idx + 1) * 35)) % 360;
        });
        this.activeDialIndex = 0;
        this.render({ force: true });
    }

    /**
     * Вращение текущего выбранного диска на угол deltaDeg с расходом ресурса и поиском скрытого паза
     */
    _rotateActiveDial(deltaDeg) {
        if (this.isJammed) {
            this._triggerJammedReaction();
            return;
        }

        const dial = this.dials[this.activeDialIndex];
        if (!dial) return;

        // Если кольцо уже зафиксировано в пазе — его больше нельзя вращать
        if (dial.isLocked) return;

        // Расход ресурса завода пружины за действие вращения
        const cost = Math.abs(deltaDeg) * this.dialDrainPerDegree;
        this.dialTension = Math.max(0, this.dialTension - cost);

        // Обновляем шкалу завода в DOM
        const bar = this.element?.querySelector(".nock-dials-game-wrap .nock-durability-fill");
        const num = this.element?.querySelector(".nock-dials-game-wrap .nock-durability-num");
        if (bar) {
            bar.style.width = `${Math.max(0, this.dialTension)}%`;
            if (this.dialTension < 30) bar.classList.add("critical");
            else bar.classList.remove("critical");
        }
        if (num) num.textContent = `${Math.max(0, Math.round(this.dialTension))}%`;

        // Проверка исчерпания ресурса
        if (this.dialTension <= 0) {
            this._onDialsExhaustion();
            return;
        }

        dial.currentAngle = (dial.currentAngle + deltaDeg) % 360;
        if (dial.currentAngle < 0) dial.currentAngle += 360;

        // Обновляем визуальный DOM-слой
        const layer = this.element?.querySelector(`.nock-dial-layer[data-index="${this.activeDialIndex}"]`);
        if (layer) {
            layer.style.transform = `rotate(${dial.currentAngle}deg)`;
        }

        // Проверяем попадание в скрытый механический паз-фиксатор
        let diff = Math.abs(dial.currentAngle - dial.catchAngle);
        if (diff > 180) diff = 360 - diff;

        if (diff <= dial.tolerance) {
            // ЩЕЛЧОК! Кольцо уперлось в упор и защелкнулось!
            dial.currentAngle = dial.catchAngle;
            dial.isLocked = true;
            dial.isAligned = true;

            if (layer) {
                layer.style.transform = `rotate(${dial.catchAngle}deg)`;
                layer.classList.add("aligned", "locked");
            }

            const selBtn = this.element?.querySelector(`.nock-dial-sel-btn[data-index="${this.activeDialIndex}"]`);
            if (selBtn) {
                selBtn.classList.add("aligned");
                const icon = selBtn.querySelector("i");
                if (icon) icon.className = "fas fa-check-circle";
            }

            // Звук тяжелого механического упора
            const successSound = game.settings.get(NOCK_CONST.MODULE_ID, "successSound");
            if (successSound) foundry.audio.AudioHelper.play({ src: successSound, volume: 0.7 }, true);

            // Проверяем, защелкнуты ли все диски
            if (this.dials.every(d => d.isLocked)) {
                this._onUnlockSuccess();
                return;
            }

            ui.notifications.info(`${dial.label} защелкнуто в пазе!`);

            // Автоматически переключаем на следующее незапертое кольцо
            const nextIdx = this.dials.findIndex(d => !d.isLocked);
            if (nextIdx !== -1) {
                this.activeDialIndex = nextIdx;
                this.render({ force: true });
            }
        }
    }

    /**
     * Проверка сцепления всех дисков и открытие замка
     */
    async _attemptLockDials() {
        if (this.isJammed) {
            this._triggerJammedReaction();
            return;
        }

        if (this.dials.every(d => d.isLocked)) {
            const arena = this.element?.querySelector(".nock-dials-arena");
            if (arena) arena.classList.add("nock-unlocked-glow");
            await this._onUnlockSuccess();
            return;
        }

        const lockedCount = this.dials.filter(d => d.isLocked).length;
        ui.notifications.warn(`Зафиксировано ${lockedCount} из ${this.dials.length} дисков. Вращайте незапертые кольца до паза!`);
    }

    /**
     * Интерактивные события вращения колец мышью и кнопками
     */
    _setupDialsEvents() {
        const arena = this.element?.querySelector(".nock-dials-arena");
        const btnRotLeft = this.element?.querySelector("#nock-dial-rot-left");
        const btnRotRight = this.element?.querySelector("#nock-dial-rot-right");
        const btnLock = this.element?.querySelector("#nock-dial-lock-btn");

        if (btnRotLeft) {
            btnRotLeft.addEventListener("click", () => this._rotateActiveDial(-12));
        }
        if (btnRotRight) {
            btnRotRight.addEventListener("click", () => this._rotateActiveDial(12));
        }
        if (btnLock) {
            btnLock.addEventListener("click", () => this._attemptLockDials());
        }

        if (arena) {
            let isDragging = false;
            let lastMouseAngle = 0;

            const onPointerDown = (e) => {
                if (this.isJammed) {
                    this._triggerJammedReaction();
                    return;
                }

                const rect = arena.getBoundingClientRect();
                const centerX = rect.left + rect.width / 2;
                const centerY = rect.top + rect.height / 2;
                const clientX = e.clientX || (e.touches && e.touches[0]?.clientX);
                const clientY = e.clientY || (e.touches && e.touches[0]?.clientY);
                if (clientX === undefined || clientY === undefined) return;

                const dx = clientX - centerX;
                const dy = clientY - centerY;
                const radius = Math.sqrt(dx * dx + dy * dy);

                // Определение кольца по радиусу клика
                const count = this.dials.length;
                let clickedIndex = -1;
                if (count === 3) {
                    if (radius > 109 && radius <= 150) clickedIndex = 0;
                    else if (radius > 69 && radius <= 109) clickedIndex = 1;
                    else if (radius > 29 && radius <= 69) clickedIndex = 2;
                } else if (count === 4) {
                    if (radius > 119 && radius <= 150) clickedIndex = 0;
                    else if (radius > 89 && radius <= 119) clickedIndex = 1;
                    else if (radius > 59 && radius <= 89) clickedIndex = 2;
                    else if (radius > 29 && radius <= 59) clickedIndex = 3;
                } else {
                    if (radius > 125 && radius <= 150) clickedIndex = 0;
                    else if (radius > 101 && radius <= 125) clickedIndex = 1;
                    else if (radius > 77 && radius <= 101) clickedIndex = 2;
                    else if (radius > 53 && radius <= 77) clickedIndex = 3;
                    else if (radius > 29 && radius <= 53) clickedIndex = 4;
                }

                if (clickedIndex !== -1 && clickedIndex !== this.activeDialIndex) {
                    this.activeDialIndex = clickedIndex;
                    arena.querySelectorAll(".nock-dial-layer").forEach((el, idx) => {
                        if (idx === this.activeDialIndex) el.classList.add("selected");
                        else el.classList.remove("selected");
                    });
                    this.element.querySelectorAll(".nock-dial-sel-btn").forEach((btn, idx) => {
                        if (idx === this.activeDialIndex) btn.classList.add("active");
                        else btn.classList.remove("active");
                    });
                }

                isDragging = true;
                lastMouseAngle = Math.atan2(dy, dx) * (180 / Math.PI);
            };

            const onPointerMove = (e) => {
                if (!isDragging || this.isJammed) return;

                const rect = arena.getBoundingClientRect();
                const centerX = rect.left + rect.width / 2;
                const centerY = rect.top + rect.height / 2;
                const clientX = e.clientX || (e.touches && e.touches[0]?.clientX);
                const clientY = e.clientY || (e.touches && e.touches[0]?.clientY);
                if (clientX === undefined || clientY === undefined) return;

                const dx = clientX - centerX;
                const dy = clientY - centerY;
                const currentMouseAngle = Math.atan2(dy, dx) * (180 / Math.PI);

                let delta = currentMouseAngle - lastMouseAngle;
                if (delta > 180) delta -= 360;
                else if (delta < -180) delta += 360;

                lastMouseAngle = currentMouseAngle;
                this._rotateActiveDial(delta);
            };

            const onPointerUp = () => {
                isDragging = false;
            };

            if (this._boundDialPointerMove) {
                window.removeEventListener("mousemove", this._boundDialPointerMove);
                window.removeEventListener("touchmove", this._boundDialPointerMove);
                window.removeEventListener("mouseup", this._boundDialPointerUp);
                window.removeEventListener("touchend", this._boundDialPointerUp);
            }

            this._boundDialPointerMove = onPointerMove;
            this._boundDialPointerUp = onPointerUp;

            arena.addEventListener("mousedown", onPointerDown);
            arena.addEventListener("touchstart", onPointerDown);
            window.addEventListener("mousemove", this._boundDialPointerMove);
            window.addEventListener("touchmove", this._boundDialPointerMove);
            window.addEventListener("mouseup", this._boundDialPointerUp);
            window.addEventListener("touchend", this._boundDialPointerUp);
        }
    }


    /**
     * Реакция на попытку взаимодействовать с заклинившим замком
     */
    _triggerJammedReaction() {
        const jamSound = game.settings.get(NOCK_CONST.MODULE_ID, "jamSound");
        if (jamSound) foundry.audio.AudioHelper.play({ src: jamSound, volume: 0.9 }, true);

        const arena = this.element?.querySelector(".nock-cylinder-arena, .nock-pins-arena, .nock-dials-arena, .dice-core-zone");
        if (arena) {
            arena.classList.remove("nock-jammed-clank");
            void arena.offsetWidth; // перезапуск анимации
            arena.classList.add("nock-jammed-clank");
            setTimeout(() => arena.classList.remove("nock-jammed-clank"), 450);
        }
        ui.notifications.error("Замок заклинило! Механизм поврежден и больше не поддается взлому.");
    }

    /**
     * Настройка интерактивных событий цилиндра
     */
    _setupCylinderEvents() {
        const arena = this.element.querySelector(".nock-cylinder-arena");
        const turnBtn = this.element.querySelector("#nock-turn-cylinder-btn");

        if (arena) {
            arena.addEventListener("mousemove", (e) => {
                if (this.isJammed || this.isTurningCylinder) return;
                const rect = arena.getBoundingClientRect();
                const x = e.clientX - rect.left - (rect.width / 2);
                const rawAngle = (x / (rect.width / 2)) * 85;
                this.pickAngle = Math.max(-85, Math.min(85, rawAngle));
                
                const pickLayer = arena.querySelector(".nock-pick-layer");
                if (pickLayer) pickLayer.style.transform = `rotate(${this.pickAngle}deg)`;
            });

            arena.addEventListener("click", () => {
                if (this.isJammed) this._triggerJammedReaction();
            });
        }

        if (turnBtn) {
            const startTurn = (e) => {
                e.preventDefault();
                if (this.isJammed) {
                    this._triggerJammedReaction();
                    return;
                }
                this._startCylinderTurn();
            };

            turnBtn.addEventListener("mousedown", startTurn);
            turnBtn.addEventListener("touchstart", startTurn);
            window.removeEventListener("mouseup", this._boundStopCylinder);
            window.removeEventListener("touchend", this._boundStopCylinder);
            window.addEventListener("mouseup", this._boundStopCylinder);
            window.addEventListener("touchend", this._boundStopCylinder);
        }
    }

    /**
     * Поворот цилиндра отмычкой (многоэтапный цикл сувальд)
     */
    _startCylinderTurn() {
        if (this.isJammed) {
            this._triggerJammedReaction();
            return;
        }
        if (this.isTurningCylinder) return;
        this.isTurningCylinder = true;

        const arena = this.element.querySelector(".nock-cylinder-arena");
        if (!arena) return;

        const cylinder = arena.querySelector(".nock-lock-cylinder");
        const tensionTool = arena.querySelector(".nock-tension-tool");
        const pickGraphic = arena.querySelector(".nock-pick-graphic");
        const strainFill = this.element.querySelector(".nock-cylinder-game-wrap .nock-strain-fill");
        const strainNum = this.element.querySelector(".nock-cylinder-game-wrap .nock-durability-num");

        const targetLimit = this.cylinderStages[this.currentCylinderStage];
        const prevLimit = this.currentCylinderStage === 0 ? 0 : this.cylinderStages[this.currentCylinderStage - 1];

        clearInterval(this._cylinderInterval);
        this._cylinderInterval = setInterval(async () => {
            if (!this.isTurningCylinder) {
                clearInterval(this._cylinderInterval);
                return;
            }

            const diff = Math.abs(this.pickAngle - this.sweetSpotAngle);
            const inSweetSpot = diff <= this.sweetSpotTolerance;

            if (inSweetSpot) {
                // В секторе: напряжение спадает, цилиндр мягко поворачивается к цели
                this.pickStrain = Math.max(0, this.pickStrain - 6);
                if (pickGraphic) pickGraphic.classList.remove("nock-pick-strain");

                if (this.cylinderAngle < targetLimit) {
                    this.cylinderAngle += 2.5;
                    if (this.cylinderAngle > targetLimit) this.cylinderAngle = targetLimit;

                    if (cylinder) cylinder.style.transform = `rotate(${this.cylinderAngle}deg)`;
                    if (tensionTool) tensionTool.style.transform = `rotate(${this.cylinderAngle}deg)`;
                }

                // Достигли рубежа текущей фазы?
                if (this.cylinderAngle >= targetLimit) {
                    const successSound = game.settings.get(NOCK_CONST.MODULE_ID, "successSound");
                    if (successSound) foundry.audio.AudioHelper.play({ src: successSound, volume: 0.7 }, true);

                    // Если это финальная фаза (90°) — замок открыт!
                    if (this.currentCylinderStage >= this.cylinderStages.length - 1) {
                        clearInterval(this._cylinderInterval);
                        this.isTurningCylinder = false;
                        await this._onUnlockSuccess();
                        return;
                    }

                    // Переход к следующей фазе сувальд
                    this.currentCylinderStage++;
                    this.sweetSpotAngle = this.stageSweetSpots[this.currentCylinderStage];
                    ui.notifications.info(`Сувальда защелкнулась! (Фаза ${this.currentCylinderStage}/${this.cylinderStages.length}). Сместите шпильку для следующего доворота.`);
                    
                    clearInterval(this._cylinderInterval);
                    this.isTurningCylinder = false;
                    return;
                }
            } else {
                // Вне сектора: замок стопорится, нарастает напряжение шпильки
                const slack = Math.max(0, 10 * (1 - Math.min(1, diff / 40)));
                const maxJamAngle = prevLimit + slack;
                if (this.cylinderAngle < maxJamAngle) {
                    this.cylinderAngle += 1;
                    if (cylinder) cylinder.style.transform = `rotate(${this.cylinderAngle}deg)`;
                    if (tensionTool) tensionTool.style.transform = `rotate(${this.cylinderAngle}deg)`;
                }

                // Шпилька вибрирует и накапливает напряжение
                if (pickGraphic) pickGraphic.classList.add("nock-pick-strain");
                const currentStrainRate = typeof this.strainRate === "number" ? this.strainRate : 2.4;
                this.pickStrain = Math.min(100, this.pickStrain + currentStrainRate);

                // Если ПЕРЕДАВИЛ (100%): шпилька ломается!
                if (this.pickStrain >= 100) {
                    clearInterval(this._cylinderInterval);
                    this.isTurningCylinder = false;
                    if (pickGraphic) pickGraphic.classList.remove("nock-pick-strain");
                    await this._onPickBreak();
                    return;
                }
            }

            // Обновление шкалы напряжения в DOM
            if (strainFill) {
                strainFill.style.width = `${Math.round(this.pickStrain)}%`;
                if (this.pickStrain > 60) strainFill.classList.add("critical");
                else strainFill.classList.remove("critical");
            }
            if (strainNum) strainNum.textContent = `${Math.round(this.pickStrain)}%`;
        }, 25);
    }

    _stopCylinderTurn() {
        this.isTurningCylinder = false;
        clearInterval(this._cylinderInterval);

        const arena = this.element?.querySelector(".nock-cylinder-arena");
        if (arena) {
            const cylinder = arena.querySelector(".nock-lock-cylinder");
            const tensionTool = arena.querySelector(".nock-tension-tool");
            const pickGraphic = arena.querySelector(".nock-pick-graphic");

            if (pickGraphic) pickGraphic.classList.remove("nock-pick-strain");

            // Возврат цилиндра к рубежу уже зафиксированной фазы
            const lockedLimit = this.currentCylinderStage === 0 ? 0 : this.cylinderStages[this.currentCylinderStage - 1];
            this.cylinderAngle = lockedLimit;
            if (cylinder) cylinder.style.transform = `rotate(${this.cylinderAngle}deg)`;
            if (tensionTool) tensionTool.style.transform = `rotate(${this.cylinderAngle}deg)`;
        }

        // Мгновенный сброс напряжения при отпускании Пробела / кнопки
        this.pickStrain = 0;
        const strainFill = this.element?.querySelector(".nock-cylinder-game-wrap .nock-strain-fill");
        const strainNum = this.element?.querySelector(".nock-cylinder-game-wrap .nock-durability-num");
        if (strainFill) {
            strainFill.style.width = "0%";
            strainFill.classList.remove("critical");
        }
        if (strainNum) strainNum.textContent = "0%";
    }

    /**
     * Поломка отмычки от перенапряжения
     */
    async _onPickBreak() {
        ui.notifications.warn("Передавили! Шпилька треснула и сломалась!");
        this.pickStrain = 0;
        this.cylinderAngle = 0;
        this.currentCylinderStage = 0;
        this.sweetSpotAngle = this.stageSweetSpots[0];

        const arena = this.element?.querySelector(".nock-cylinder-arena");
        if (arena) {
            const cylinder = arena.querySelector(".nock-lock-cylinder");
            const tensionTool = arena.querySelector(".nock-tension-tool");
            if (cylinder) cylinder.style.transform = `rotate(0deg)`;
            if (tensionTool) tensionTool.style.transform = `rotate(0deg)`;
        }

        const strainFill = this.element?.querySelector(".nock-cylinder-game-wrap .nock-strain-fill");
        const strainNum = this.element?.querySelector(".nock-cylinder-game-wrap .nock-durability-num");
        if (strainFill) {
            strainFill.style.width = "0%";
            strainFill.classList.remove("critical");
        }
        if (strainNum) strainNum.textContent = "0%";

        const flags = this.targetDoc.getFlag(NOCK_CONST.MODULE_ID, NOCK_CONST.FLAGS.DATA) || {};
        const maxAttempts = flags.maxAttempts || 0;
        const nextFails = (flags.failedAttempts || 0) + 1;

        if (maxAttempts > 0 && nextFails >= maxAttempts) {
            this.isJammed = true;
            this._triggerJammedReaction();
        } else {
            const failSound = game.settings.get(NOCK_CONST.MODULE_ID, "failSound");
            if (failSound) foundry.audio.AudioHelper.play({ src: failSound, volume: 0.7 }, true);
        }

        await nockSocket.executeAsGM("recordFailure", { uuid: this.targetDoc.uuid });
        this.render({ force: true });
    }

    /**
     * Настройка интерактивных событий штифтового замка (непрерывный подъем и фиксация)
     */
    _setupPinsEvents() {
        const arena = this.element.querySelector(".nock-pins-arena");
        const btnPrev = this.element.querySelector("#nock-pin-prev");
        const btnNext = this.element.querySelector("#nock-pin-next");
        const btnPush = this.element.querySelector("#nock-pin-push");
        const chambers = this.element.querySelectorAll(".nock-chamber");

        if (btnPrev) {
            btnPrev.addEventListener("click", () => {
                if (this.isJammed) {
                    this._triggerJammedReaction();
                    return;
                }
                this.activePinIndex = Math.max(0, this.activePinIndex - 1);
                this.render({ force: true });
            });
        }

        if (btnNext) {
            btnNext.addEventListener("click", () => {
                if (this.isJammed) {
                    this._triggerJammedReaction();
                    return;
                }
                this.activePinIndex = Math.min(this.pins.length - 1, this.activePinIndex + 1);
                this.render({ force: true });
            });
        }

        chambers.forEach((chamber, idx) => {
            chamber.addEventListener("click", () => {
                if (this.isJammed) {
                    this._triggerJammedReaction();
                    return;
                }
                this.activePinIndex = idx;
                this.render({ force: true });
            });
        });

        if (btnPush) {
            btnPush.addEventListener("mousedown", (e) => {
                e.preventDefault();
                this._startPinRise();
            });
            btnPush.addEventListener("touchstart", (e) => {
                e.preventDefault();
                this._startPinRise();
            });
        }

        if (!this._boundPinRelease) {
            this._boundPinRelease = () => this._releasePin();
        }
        window.removeEventListener("mouseup", this._boundPinRelease);
        window.removeEventListener("touchend", this._boundPinRelease);
        window.addEventListener("mouseup", this._boundPinRelease);
        window.addEventListener("touchend", this._boundPinRelease);
    }

    /**
     * Плавный непрерывный подъем активного штифта в реальном времени
     */
    _startPinRise() {
        if (this.isJammed) {
            this._triggerJammedReaction();
            return;
        }
        if (this.isPushingPin) return;

        const curPin = this.pins[this.activePinIndex];
        if (!curPin || curPin.isLocked) return;

        this.isPushingPin = true;

        const arena = this.element?.querySelector(".nock-pins-arena");
        const chamber = arena?.querySelector(`.nock-chamber[data-index="${this.activePinIndex}"]`);
        if (!chamber) return;

        const pushBtn = this.element?.querySelector("#nock-pin-push");
        if (pushBtn) pushBtn.innerHTML = '<i class="fas fa-arrow-up"></i> ПОДЪЕМ ШТИФТА...';

        const driverEl = chamber.querySelector(".nock-driver-pin");
        const keyEl = chamber.querySelector(".nock-key-pin");
        const springEl = chamber.querySelector(".nock-spring");
        const lifterEl = arena.querySelector(".nock-lifter-tool");

        clearInterval(this._pinRiseInterval);
        this._pinRiseInterval = setInterval(() => {
            if (!this.isPushingPin) {
                clearInterval(this._pinRiseInterval);
                return;
            }

            curPin.currentLift += this.pinSpeed;

            // Визуальное обновление в реальном времени
            if (driverEl) driverEl.style.transform = `translateY(-${curPin.currentLift}px)`;
            if (keyEl) keyEl.style.transform = `translateY(-${curPin.currentLift}px)`;
            if (springEl) springEl.style.height = `${Math.max(10, curPin.driverRestTop - curPin.currentLift)}px`;
            if (lifterEl) lifterEl.style.transform = `translateY(-${curPin.currentLift}px)`;

            // Индикация зоны среза в реальном времени
            const inSweetZone = Math.abs(curPin.currentLift - curPin.targetLift) <= this.pinTolerance;
            if (inSweetZone) {
                if (!chamber.classList.contains("sweet-spot-ready")) {
                    chamber.classList.add("sweet-spot-ready");
                    if (pushBtn) {
                        pushBtn.classList.add("in-sweet-spot");
                        pushBtn.innerHTML = '<i class="fas fa-check-circle"></i> ОТПУСКАЙТЕ СЕЙЧАС!';
                    }
                }
            } else {
                if (chamber.classList.contains("sweet-spot-ready")) {
                    chamber.classList.remove("sweet-spot-ready");
                    if (pushBtn) {
                        pushBtn.classList.remove("in-sweet-spot");
                        pushBtn.innerHTML = '<i class="fas fa-arrow-up"></i> ПОДЪЕМ ШТИФТА...';
                    }
                }
            }

            // Перебор: штифт ударился о верхнюю стенку (152px)
            if (curPin.currentLift >= 152) {
                clearInterval(this._pinRiseInterval);
                this.isPushingPin = false;
                this._onPinOvershoot(curPin, chamber, driverEl, keyEl, springEl, lifterEl);
            }
        }, 16);
    }

    /**
     * Отпускание штифта: проверка попадания в окно линии среза (Shear Line)
     */
    async _releasePin() {
        if (!this.isPushingPin) return;
        this.isPushingPin = false;
        clearInterval(this._pinRiseInterval);

        const curPin = this.pins[this.activePinIndex];
        if (!curPin || curPin.isLocked) return;

        const arena = this.element?.querySelector(".nock-pins-arena");
        const chamber = arena?.querySelector(`.nock-chamber[data-index="${this.activePinIndex}"]`);
        const driverEl = chamber?.querySelector(".nock-driver-pin");
        const keyEl = chamber?.querySelector(".nock-key-pin");
        const springEl = chamber?.querySelector(".nock-spring");
        const lifterEl = arena?.querySelector(".nock-lifter-tool");

        if (chamber) chamber.classList.remove("sweet-spot-ready");
        const pushBtn = this.element?.querySelector("#nock-pin-push");
        if (pushBtn) {
            pushBtn.classList.remove("in-sweet-spot");
            pushBtn.innerHTML = '<i class="fas fa-arrow-up"></i> УДЕРЖИВАТЬ ДЛЯ ПОДЪЕМА';
        }

        // Расстояние от текущего подъема до линии среза
        const gap = Math.abs(curPin.currentLift - curPin.targetLift);

        if (gap <= this.pinTolerance) {
            // УСПЕХ! Штифт зафиксирован на линии среза!
            curPin.isLocked = true;
            curPin.currentLift = curPin.targetLift;

            if (chamber) chamber.classList.add("locked");
            if (driverEl) {
                driverEl.classList.add("locked");
                driverEl.style.transform = `translateY(-${curPin.targetLift}px)`;
            }
            if (keyEl) {
                keyEl.classList.add("locked");
                keyEl.style.transform = `translateY(0px)`;
            }
            if (springEl) springEl.style.height = `${Math.max(10, curPin.targetShearY - 60)}px`;
            if (lifterEl) lifterEl.style.transform = `translateY(0px)`;

            // Звук щелчка фиксатора
            const successSound = game.settings.get(NOCK_CONST.MODULE_ID, "successSound");
            if (successSound) foundry.audio.AudioHelper.play({ src: successSound, volume: 0.7 }, true);

            // Проверяем, зафиксированы ли ВСЕ штифты
            if (this.pins.every(p => p.isLocked)) {
                await this._onUnlockSuccess();
                return;
            }

            ui.notifications.info(`Штифт ${curPin.id + 1} зафиксирован на линии среза!`);

            // Переход к следующему незапертому штифту
            const nextIdx = this.pins.findIndex(p => !p.isLocked);
            if (nextIdx !== -1) {
                this.activePinIndex = nextIdx;
                this.render({ force: true });
            }

        } else {
            // Штифт не попал в окно линии среза — пружинный отскок вниз
            curPin.currentLift = 0;
            if (driverEl) driverEl.style.transform = `translateY(0px)`;
            if (keyEl) keyEl.style.transform = `translateY(0px)`;
            if (springEl) springEl.style.height = `${curPin.driverRestTop}px`;
            if (lifterEl) lifterEl.style.transform = `translateY(0px)`;

            const failSound = game.settings.get(NOCK_CONST.MODULE_ID, "failSound");
            if (failSound) foundry.audio.AudioHelper.play({ src: failSound, volume: 0.4 }, true);

            ui.notifications.warn("Штифт сорвался! Отпустите в момент зеленой подсветки на линии среза.");
        }
    }

    /**
     * Срыв штифта при чрезмерном подъеме
     */
    async _onPinOvershoot(curPin, chamber, driverEl, keyEl, springEl, lifterEl) {
        if (chamber) chamber.classList.remove("sweet-spot-ready");
        const pushBtn = this.element?.querySelector("#nock-pin-push");
        if (pushBtn) {
            pushBtn.classList.remove("in-sweet-spot");
            pushBtn.innerHTML = '<i class="fas fa-arrow-up"></i> УДЕРЖИВАТЬ ДЛЯ ПОДЪЕМА';
        }

        curPin.currentLift = 0;
        if (driverEl) driverEl.style.transform = `translateY(0px)`;
        if (keyEl) keyEl.style.transform = `translateY(0px)`;
        if (springEl) springEl.style.height = `${curPin.driverRestTop}px`;
        if (lifterEl) lifterEl.style.transform = `translateY(0px)`;

        ui.notifications.warn("Перебор! Штифт ударился о свод камеры и сорвался!");

        const failSound = game.settings.get(NOCK_CONST.MODULE_ID, "failSound");
        if (failSound) foundry.audio.AudioHelper.play({ src: failSound, volume: 0.6 }, true);

        const flags = this.targetDoc.getFlag(NOCK_CONST.MODULE_ID, NOCK_CONST.FLAGS.DATA) || {};
        const maxAttempts = flags.maxAttempts || 0;
        const nextFails = (flags.failedAttempts || 0) + 1;

        if (maxAttempts > 0 && nextFails >= maxAttempts) {
            this.isJammed = true;
            this._triggerJammedReaction();
        }

        await nockSocket.executeAsGM("recordFailure", { uuid: this.targetDoc.uuid });
        this.render({ force: true });
    }

    _onKeyDown(e) {
        if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")) return;

        // Если замок заклинило - полное блокирование с металлической отдачей
        if (this.isJammed) {
            if (e.code === "Space" || e.code === "ArrowUp" || e.code === "ArrowLeft" || e.code === "ArrowRight" || e.key === "d" || e.key === "D" || e.key === "в" || e.key === "В") {
                e.preventDefault();
                this._triggerJammedReaction();
            }
            return;
        }

        if (this.activeMode === 'cylinder') {
            if (e.code === "Space" || e.key === "d" || e.key === "D" || e.key === "в" || e.key === "В") {
                e.preventDefault();
                this._startCylinderTurn();
            }
        } else if (this.activeMode === 'pins') {
            if (e.code === "ArrowLeft" || e.key === "a" || e.key === "A" || e.key === "ф" || e.key === "Ф") {
                e.preventDefault();
                this.activePinIndex = Math.max(0, this.activePinIndex - 1);
                this.render({ force: true });
            } else if (e.code === "ArrowRight" || e.key === "d" || e.key === "D" || e.key === "в" || e.key === "В") {
                e.preventDefault();
                this.activePinIndex = Math.min(this.pins.length - 1, this.activePinIndex + 1);
                this.render({ force: true });
            } else if (e.code === "Space" || e.code === "ArrowUp" || e.key === "w" || e.key === "W" || e.key === "ц" || e.key === "Ц") {
                e.preventDefault();
                this._startPinRise();
            }
        } else if (this.activeMode === 'dials') {
            if (e.code === "Digit1" && this.dials[0]) {
                e.preventDefault();
                this.activeDialIndex = 0;
                this.render({ force: true });
            } else if (e.code === "Digit2" && this.dials[1]) {
                e.preventDefault();
                this.activeDialIndex = 1;
                this.render({ force: true });
            } else if (e.code === "Digit3" && this.dials[2]) {
                e.preventDefault();
                this.activeDialIndex = 2;
                this.render({ force: true });
            } else if (e.code === "Digit4" && this.dials[3]) {
                e.preventDefault();
                this.activeDialIndex = 3;
                this.render({ force: true });
            } else if (e.code === "Digit5" && this.dials[4]) {
                e.preventDefault();
                this.activeDialIndex = 4;
                this.render({ force: true });
            } else if (e.code === "ArrowLeft" || e.key === "a" || e.key === "A" || e.key === "ф" || e.key === "Ф") {
                e.preventDefault();
                this._rotateActiveDial(-8);
            } else if (e.code === "ArrowRight" || e.key === "d" || e.key === "D" || e.key === "в" || e.key === "В") {
                e.preventDefault();
                this._rotateActiveDial(8);
            } else if (e.code === "Space" || e.code === "Enter") {
                e.preventDefault();
                this._attemptLockDials();
            }
        }
    }

    _onKeyUp(e) {
        if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")) return;
        if (this.isJammed) return;

        if (this.activeMode === 'cylinder') {
            if (e.code === "Space" || e.key === "d" || e.key === "D" || e.key === "в" || e.key === "В") {
                this._stopCylinderTurn();
            }
        } else if (this.activeMode === 'pins') {
            if (e.code === "Space" || e.code === "ArrowUp" || e.key === "w" || e.key === "W" || e.key === "ц" || e.key === "Ц") {
                this._releasePin();
            }
        }
    }

    async _prepareContext(options) {
        const adapter = SystemManager.get();
        const flags = this.targetDoc.getFlag(NOCK_CONST.MODULE_ID, NOCK_CONST.FLAGS.DATA) || {};
        const dc = adapter.getDC(this.targetDoc);
        
        const actorData = adapter.getActorData(this.actor);
        
        const allowedStats = flags.allowedStats || {};
        const hasAllowedConstraints = Object.values(allowedStats).some(v => v === true);
        
        if (hasAllowedConstraints && !allowedStats[this.selectedStat]) {
            const firstAllowed = Object.keys(allowedStats).find(k => allowedStats[k]);
            if (firstAllowed) this.selectedStat = firstAllowed;
        }
        
        let hasKey = false;
        if (flags.key && this.actor) {
            const keyUuid = flags.key.uuid;
            const keyName = (flags.key.name || "").trim().toLowerCase();
            const keySlug = flags.key.slug || (keyName ? keyName.replace(/\s+/g, "-") : "");

            hasKey = !!this.actor.items.find(i => {
                if (keyUuid && (i.uuid === keyUuid || i.flags?.core?.sourceId === keyUuid)) return true;
                const iName = (i.name || "").trim().toLowerCase();
                if (keyName && iName === keyName) return true;
                if (keySlug && (i.system?.slug === keySlug || iName.replace(/\s+/g, "-") === keySlug)) return true;
                return false;
            });
        }

        const currentStat = actorData.stats.find(s => s.id === this.selectedStat);
        const statMod = currentStat?.mod || 0;
        const toolBonus = actorData.toolBonus || 0;
        const toolName = actorData.toolName;

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
        this.isJammed = false;
        
        if (maxAttempts > 0) {
            remaining = Math.max(0, maxAttempts - failedAttempts);
            this.isJammed = remaining === 0;
        }

        // --- ОПРЕДЕЛЕНИЕ ДОСТУПНЫХ МЕХАНИЗМОВ ---
        const mechanisms = flags.mechanisms || {
            dice: true,
            cylinder: true,
            pins: true,
            dials: true
        };
        if (mechanisms.dials === undefined) mechanisms.dials = true;

        const availableModes = Object.keys(mechanisms).filter(k => mechanisms[k]);
        if (!this.activeMode || !mechanisms[this.activeMode]) {
            if (mechanisms.cylinder) this.activeMode = 'cylinder';
            else if (mechanisms.pins) this.activeMode = 'pins';
            else if (mechanisms.dials) this.activeMode = 'dials';
            else this.activeMode = 'dice';
        }

        // Инициализируем данные механического цилиндра под текущую сложность
        this._initCylinderData(dc);

        // Инициализируем данные штифтов под текущую сложность
        this._initPinsData(dc);

        // Инициализируем данные дисков под текущую сложность
        this._initDialsData(dc);

        // Динамически обновляем допуски и характеристики под актуальный выбранный стат и введённый бонус
        this._updateTolerances(dc);

        // Данные активных колец криптекса
        const activeDials = this.dials.map((dial, idx) => {
            let diff = Math.abs(dial.currentAngle - dial.catchAngle);
            if (diff > 180) diff = 360 - diff;
            const isAligned = dial.isLocked || (diff <= dial.tolerance);
            dial.isAligned = isAligned;
            return {
                index: idx,
                ringNumber: dial.ringNumber,
                label: dial.label,
                texture: dial.texture,
                currentAngle: Math.round(dial.currentAngle),
                isSelected: idx === this.activeDialIndex,
                isAligned: isAligned
            };
        });

        // Построение динамической SVG ломаной линии среза (Shear Line Path) для любого числа штифтов
        let shearPathD = "";
        if (this.pins.length > 0) {
            shearPathD = `M 0,${this.pins[0].targetShearY}`;
            for (const p of this.pins) {
                shearPathD += ` L ${p.centerX},${p.targetShearY}`;
            }
            shearPathD += ` L 408,${this.pins[this.pins.length - 1].targetShearY}`;
        }

        // Данные для рендера камер штифтов
        const pinsChambers = this.pins.map((pin, idx) => {
            const isSelected = idx === this.activePinIndex;
            const lift = pin.isLocked ? pin.targetLift : pin.currentLift;
            const keyRestTop = pin.keyRestTop ?? (225 - pin.keyHeight);
            const driverRestTop = pin.driverRestTop ?? (keyRestTop - 60);
            const springHeight = pin.isLocked ? Math.max(10, pin.targetShearY - 60) : Math.max(10, driverRestTop - lift);
            return {
                isSelected: isSelected,
                isLocked: pin.isLocked,
                centerX: pin.centerX,
                targetShearY: pin.targetShearY,
                keyHeight: pin.keyHeight,
                keyRestTop: keyRestTop,
                driverRestTop: driverRestTop,
                springHeight: Math.round(springHeight),
                driverY: pin.isLocked ? -(driverRestTop - (pin.targetShearY - 60)) : -Math.round(lift),
                keyY: pin.isLocked ? 0 : -Math.round(lift)
            };
        });

        const curActivePin = this.pins[this.activePinIndex];
        const activePickX = curActivePin ? curActivePin.centerX : 51;
        const activeLiftY = curActivePin ? (curActivePin.isLocked ? 0 : curActivePin.currentLift) : 0;
        
        return {
            flags: { ...flags, dc: dc },
            allowedStats: actorData.stats.reduce((acc, s) => {
                acc[s.id] = hasAllowedConstraints ? (allowedStats[s.id] || false) : true;
                return acc;
            }, {}),
            statsList: actorData.stats,
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
            isJammed: this.isJammed,
            isCPR: adapter.id === "cyberpunk-red-core",
            // Механизмы:
            mechanisms: mechanisms,
            hasMultipleModes: availableModes.length > 1,
            activeMode: this.activeMode,
            pickStrain: Math.max(0, Math.round(this.pickStrain)),
            pinsChambers: pinsChambers,
            activePickX: activePickX,
            activeLiftY: Math.round(activeLiftY),
            shearPathD: shearPathD,
            // Диски:
            activeDials: activeDials,
            dialsCount: activeDials.length,
            dialTension: Math.max(0, Math.round(this.dialTension))
        };
    }

    static _onSwitchMode(event, target) {
        clearInterval(this._dialTensionInterval);
        this.activeMode = target.dataset.mode;
        this.render({ force: true });
    }

    static _onSelectDial(event, target) {
        const idx = parseInt(target.dataset.index);
        if (!isNaN(idx)) {
            this.activeDialIndex = idx;
            this.render({ force: true });
        }
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
        const successSound = game.settings.get(NOCK_CONST.MODULE_ID, "successSound");
        if (successSound) foundry.audio.AudioHelper.play({ src: successSound, volume: 0.8 }, true);
        ui.notifications.info("Замок открыт подходящим ключом!");

        try {
            await nockSocket?.executeAsGM("requestUnlock", { uuid: this.targetDoc.uuid });
        } catch (err) {
            console.error("Nock Nock | Ошибка выполнения requestUnlock:", err);
        }
        
        const targetTitle = this.type === 'door' ? "Дверь" : (this.targetDoc.name || "замок");
        const keyName = this.targetDoc.getFlag(NOCK_CONST.MODULE_ID, NOCK_CONST.FLAGS.DATA)?.key?.name || "Ключ";

        ChatMessage.create({
            speaker: ChatMessage.getSpeaker({ actor: this.actor }),
            content: `
                <div class="nock-chat-card success" style="border-left: 4px solid #4cd137; padding: 8px 12px; background: rgba(0,0,0,0.6); color: #e8dcc0;">
                    <div style="font-weight: bold; color: #4cd137; font-size: 1.1em; margin-bottom: 4px;">
                        <i class="fas fa-key"></i> Замок открыт ключом
                    </div>
                    <div><strong>${this.actor.name}</strong> отпирает <em>${targetTitle}</em> ключом <strong>${keyName}</strong>.</div>
                </div>
            `
        });

        this.close();
    }

    /**
     * Успешное отпирание замка
     */
    async _onUnlockSuccess() {
        ui.notifications.info("Замок успешно открыт!");
        const successSound = game.settings.get(NOCK_CONST.MODULE_ID, "successSound");
        if (successSound) foundry.audio.AudioHelper.play({ src: successSound, volume: 0.8 }, true);

        // Отправляем сообщение в чат
        const targetTitle = this.type === 'door' ? "Дверь" : this.targetDoc.name;
        ChatMessage.create({
            speaker: ChatMessage.getSpeaker({ actor: this.actor }),
            content: `
                <div style="text-align: center; border: 2px solid #4cd137; border-radius: 8px; padding: 10px; background: rgba(0,0,0,0.3);">
                    <h3 style="margin: 0; color: #4cd137; letter-spacing: 2px;"><i class="fas fa-unlock"></i> ЗАМОК ВЗЛОМАН!</h3>
                    <div style="font-size: 0.9em; color: #dcb174; margin-top: 5px;">Объект: ${targetTitle}</div>
                </div>
            `
        });

        await nockSocket.executeAsGM("requestUnlock", { uuid: this.targetDoc.uuid });
        this.close();
    }

    static async _onRollDice(event, target) {
        const adapter = SystemManager.get();
        const flags = this.targetDoc.getFlag(NOCK_CONST.MODULE_ID, NOCK_CONST.FLAGS.DATA) || {};
        const dc = adapter.getDC(this.targetDoc);
        
        const maxAttempts = flags.maxAttempts || 0;
        const failedAttempts = flags.failedAttempts || 0;
        
        if (maxAttempts > 0 && failedAttempts >= maxAttempts) {
            ui.notifications.error("Замок заклинило! Больше попыток нет.");
            return;
        }

        const circle = this.element.querySelector(".roll-circle");
        if (circle) {
            circle.classList.add("nock-shake");
            await new Promise(r => setTimeout(r, 400));
            circle.classList.remove("nock-shake");
        }
        
        const rollResult = await adapter.performRoll(this.actor, {
            statId: this.selectedStat,
            dc: dc,
            bonusFormula: this.bonusValue,
            advantage: this.advantage
        });

        const success = rollResult.success;
        const roll = rollResult.roll;
        
        let attemptsText = "";
        if (!success && maxAttempts > 0) {
            const newRemaining = Math.max(0, maxAttempts - (failedAttempts + 1));
            if (newRemaining === 0) {
                attemptsText = "<br><span style='color: #e84118; font-weight: bold;'>⚠️ ЗАМОК ЗАКЛИНИЛО!</span>";
            } else {
                attemptsText = `<br><span style='color: #dcb174;'>Осталось попыток: ${newRemaining}</span>`;
            }
        }

        const flavor = `
            <div style="text-align: center; border: 2px solid ${success ? '#4cd137' : '#e84118'}; border-radius: 8px; padding: 10px; background: rgba(0,0,0,0.1); box-shadow: inset 0 0 10px ${success ? 'rgba(76, 209, 55, 0.2)' : 'rgba(232, 65, 24, 0.2)'};">
                <h3 style="margin: 0; color: ${success ? '#4cd137' : '#e84118'}; text-transform: uppercase; letter-spacing: 2px;">
                    ${success ? '<i class="fas fa-unlock"></i> УСПЕХ' : '<i class="fas fa-lock"></i> ПРОВАЛ'}
                </h3>
                <div style="font-size: 0.85em; color: #888; margin-top: 5px;">
                    Цель: ${this.type === 'door' ? 'Дверь' : this.targetDoc.name} (DC/DV ${dc})
                    ${attemptsText}
                </div>
            </div>
        `;
        
        await roll.toMessage({
            speaker: ChatMessage.getSpeaker({actor: this.actor}),
            flavor: flavor
        });
        
        if (success) {
            await this._onUnlockSuccess();
        } else {
            ui.notifications.error("Неудача...");
            
            const isNowJammed = maxAttempts > 0 && (failedAttempts + 1) >= maxAttempts;
            if (!isNowJammed) {
                const failSound = game.settings.get(NOCK_CONST.MODULE_ID, "failSound");
                if (failSound) {
                    foundry.audio.AudioHelper.play({ src: failSound, volume: 0.6 }, true);
                }
            }

            await nockSocket.executeAsGM("recordFailure", { uuid: this.targetDoc.uuid });
            this.render(true);
            
            const newFlags = this.targetDoc.getFlag(NOCK_CONST.MODULE_ID, NOCK_CONST.FLAGS.DATA) || {};
            if (maxAttempts > 0 && (newFlags.failedAttempts || 0) >= maxAttempts) {
                const jamSound = game.settings.get(NOCK_CONST.MODULE_ID, "jamSound");
                if (jamSound) {
                    foundry.audio.AudioHelper.play({ src: jamSound, volume: 0.8 }, true);
                }
            }
        }
    }

    /** @override */
    async close(options = {}) {
        document.removeEventListener("keydown", this._boundKeyHandler);
        document.removeEventListener("keyup", this._boundKeyUpHandler);
        clearInterval(this._cylinderInterval);
        clearInterval(this._pinRiseInterval);
        clearInterval(this._pinInterval);
        clearInterval(this._dialTensionInterval);

        if (this._boundStopCylinder) {
            window.removeEventListener("mouseup", this._boundStopCylinder);
            window.removeEventListener("touchend", this._boundStopCylinder);
        }

        if (this._boundPinRelease) {
            window.removeEventListener("mouseup", this._boundPinRelease);
            window.removeEventListener("touchend", this._boundPinRelease);
        }

        if (this._boundDialPointerMove) {
            window.removeEventListener("mousemove", this._boundDialPointerMove);
            window.removeEventListener("touchmove", this._boundDialPointerMove);
            window.removeEventListener("mouseup", this._boundDialPointerUp);
            window.removeEventListener("touchend", this._boundDialPointerUp);
        }

        return await super.close(options);
    }
}
