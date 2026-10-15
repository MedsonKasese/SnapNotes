function safePhotoURL(value) {
    if (!value) return "";
    try {
        const url = new URL(value, globalThis.location?.origin || "https://localhost");
        return url.protocol === "https:" ? url.href : "";
    } catch {
        return "";
    }
}

export function renderSettingsAccount(container, user, documentRef = document) {
    if (!container) return;
    container.replaceChildren();

    const avatar = documentRef.createElement("div");
    avatar.className = "settings-account-avatar";
    const details = documentRef.createElement("div");
    details.className = "settings-account-details";

    if (!user) {
        const iconWrap = documentRef.createElement("span");
        const icon = documentRef.createElement("i");
        icon.className = "fa-solid fa-user";
        icon.setAttribute("aria-hidden", "true");
        iconWrap.appendChild(icon);
        avatar.appendChild(iconWrap);

        const name = documentRef.createElement("strong");
        name.textContent = "Local mode";
        const description = documentRef.createElement("span");
        description.textContent = "Your notes are stored on this device";
        details.append(name, description);
        container.append(avatar, details);
        return;
    }

    const nameText = user.displayName || (user.email ? user.email.split("@")[0] : "SnapNotes user");
    const emailText = user.email || "";
    const provider = user.providerData?.some(item => item.providerId === "google.com")
        ? "Google account"
        : "Email account";
    const photoURL = safePhotoURL(user.photoURL);

    if (photoURL) {
        const image = documentRef.createElement("img");
        image.src = photoURL;
        image.alt = "";
        image.referrerPolicy = "no-referrer";
        avatar.appendChild(image);
    } else {
        const initials = String(user.displayName || emailText || "U")
            .trim().split(/\s+/).map(part => part[0]).join("").slice(0, 2).toUpperCase();
        const initialsElement = documentRef.createElement("span");
        initialsElement.textContent = initials || "U";
        avatar.appendChild(initialsElement);
    }

    const name = documentRef.createElement("strong");
    name.textContent = nameText;
    const email = documentRef.createElement("span");
    email.textContent = emailText || provider;
    const providerLabel = documentRef.createElement("small");
    providerLabel.textContent = provider;
    details.append(name, email, providerLabel);
    container.append(avatar, details);
}

if (typeof window !== "undefined") window.renderSettingsAccount = renderSettingsAccount;
