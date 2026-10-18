// Shared recurrence controls for reminder date/time inputs.
(() => {
    let controlId = 0;
    const FREQUENCIES = new Set(["daily", "weekly", "monthly"]);

    function localZone() {
        try {
            return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
        } catch (_) {
            return "UTC";
        }
    }

    function normalize(value, reminderAt) {
        if (!value || !reminderAt) return null;
        if (typeof window.normalizeReminderRepeat === "function") {
            return window.normalizeReminderRepeat(value, reminderAt);
        }
        return value;
    }

    function createReminderRepeatControls(reminderInput, initialRepeat = null) {
        if (!reminderInput) throw new TypeError("A reminder date input is required.");
        const id = `reminder-repeat-${++controlId}`;
        const element = document.createElement("div");
        element.className = "reminder-repeat-controls";

        const repeatLabel = document.createElement("label");
        repeatLabel.className = "reminder-repeat-field";
        repeatLabel.htmlFor = `${id}-frequency`;
        const labelText = document.createElement("span");
        labelText.textContent = "Repeat";

        const frequency = document.createElement("select");
        frequency.id = `${id}-frequency`;
        frequency.setAttribute("aria-label", "Reminder repeat frequency");
        [
            ["none", "Does not repeat"],
            ["daily", "Every day"],
            ["weekly", "Every week"],
            ["monthly", "Every month"],
            ["custom", "Custom..."]
        ].forEach(([value, text]) => {
            const option = document.createElement("option");
            option.value = value;
            option.textContent = text;
            frequency.appendChild(option);
        });
        repeatLabel.append(labelText, frequency);

        const custom = document.createElement("div");
        custom.className = "reminder-repeat-custom";
        custom.hidden = true;
        const intervalLabel = document.createElement("label");
        intervalLabel.htmlFor = `${id}-interval`;
        intervalLabel.textContent = "Repeat every";
        const interval = document.createElement("input");
        interval.id = `${id}-interval`;
        interval.type = "number";
        interval.min = "1";
        interval.max = "365";
        interval.step = "1";
        interval.value = "1";
        interval.required = true;
        interval.setAttribute("aria-label", "Custom repeat interval (1 to 365)");
        const unitLabel = document.createElement("label");
        unitLabel.htmlFor = `${id}-unit`;
        unitLabel.className = "visually-hidden";
        unitLabel.textContent = "Custom repeat unit";
        const unit = document.createElement("select");
        unit.id = `${id}-unit`;
        unit.setAttribute("aria-label", "Custom repeat unit");
        [["daily", "days"], ["weekly", "weeks"], ["monthly", "months"]].forEach(([value, text]) => {
            const option = document.createElement("option");
            option.value = value;
            option.textContent = text;
            unit.appendChild(option);
        });
        custom.append(intervalLabel, interval, unitLabel, unit);

        const help = document.createElement("p");
        help.id = `${id}-help`;
        help.className = "reminder-repeat-help";
        help.textContent = "Reminders work while SnapNotes is open. Enable background reminders in Settings for delivery while closed. Overdue repeats show once, then resume their schedule. Private reminders require unlocking, or explicit private schedule sharing for background delivery.";
        frequency.setAttribute("aria-describedby", help.id);
        element.append(repeatLabel, custom, help);

        let originalReminderValue = reminderInput.value;
        let originalRepeat = initialRepeat ? structuredClone(initialRepeat) : null;

        function updateVisibility() {
            frequency.disabled = !reminderInput.value;
            custom.hidden = !reminderInput.value || frequency.value !== "custom";
            interval.required = !custom.hidden;
            interval.setCustomValidity("");
        }

        function set(repeat) {
            const validFrequency = repeat && FREQUENCIES.has(repeat.frequency) ? repeat.frequency : null;
            const isCustom = Boolean(validFrequency && Number(repeat.interval) !== 1);
            if (!repeat) {
                frequency.value = "none";
            } else if (isCustom) {
                frequency.value = "custom";
                unit.value = validFrequency;
                interval.value = String(repeat.interval);
            } else if (validFrequency) {
                frequency.value = validFrequency;
                interval.value = "1";
            } else {
                frequency.value = "none";
            }
            originalRepeat = repeat ? structuredClone(repeat) : null;
            originalReminderValue = reminderInput.value;
            updateVisibility();
        }

        function read() {
            if (!reminderInput.value || frequency.value === "none") return null;
            const isCustom = frequency.value === "custom";
            const amount = isCustom ? Number(interval.value) : 1;
            if (isCustom && (!Number.isInteger(amount) || amount < 1 || amount > 365)) return null;
            const selectedFrequency = isCustom ? unit.value : frequency.value;
            const parsedReminder = window.parseReminderDateTimeLocal?.(reminderInput.value)
                || new Date(reminderInput.value).toISOString();
            const unchangedDate = reminderInput.value === originalReminderValue;
            const sameSchedule = originalRepeat
                && originalRepeat.frequency === selectedFrequency
                && Number(originalRepeat.interval) === amount;
            const prior = unchangedDate && sameSchedule ? originalRepeat : null;
            const value = {
                frequency: selectedFrequency,
                interval: amount,
                timeZone: prior?.timeZone || localZone(),
                anchorAt: prior?.anchorAt || parsedReminder
            };
            return typeof window.normalizeReminderRepeat === "function"
                ? normalize(value, parsedReminder)
                : value;
        }

        function validate() {
            updateVisibility();
            reminderInput.setCustomValidity("");
            if (frequency.value !== "none" && !reminderInput.value) {
                reminderInput.setCustomValidity("Choose a reminder date and time to repeat this reminder.");
                reminderInput.reportValidity();
                return false;
            }
            if (!reminderInput.value) return true;
            if (frequency.value === "custom") {
                if (!interval.checkValidity()) {
                    interval.reportValidity();
                    return false;
                }
            }
            return true;
        }

        frequency.addEventListener("change", updateVisibility);
        reminderInput.addEventListener("input", updateVisibility);
        reminderInput.addEventListener("change", updateVisibility);
        interval.addEventListener("input", () => interval.setCustomValidity(""));
        set(initialRepeat);
        return { element, read, set, validate };
    }

    window.createReminderRepeatControls = createReminderRepeatControls;
})();
