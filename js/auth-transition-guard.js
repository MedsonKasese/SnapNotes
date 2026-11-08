export function createAuthTransitionGuard({
    getDataUid,
    setDataUid,
    readLocalLibrary,
    applyLocalLibrary,
    clearPrivateUnlock
}) {
    let observedUid;
    let initialized = false;

    return async function handleAuthTransition(user) {
        const nextUid = user?.uid || null;
        if (initialized && observedUid === nextUid) {
            return { changed: false, previousUid: observedUid, nextUid };
        }

        const previousUid = initialized ? observedUid : undefined;
        observedUid = nextUid;
        initialized = true;

        const activeLibraryUid = getDataUid();
        const leavingAccountLibrary = Boolean(
            activeLibraryUid &&
            activeLibraryUid !== "local" &&
            activeLibraryUid !== nextUid
        );

        if (leavingAccountLibrary) {
            let localLibrary = null;
            try {
                localLibrary = await readLocalLibrary();
            } catch {
                // A failed local read must not trigger a fallback to the previous account's notes.
            }
            try {
                await applyLocalLibrary(localLibrary || { notes: [], folders: [] });
            } catch {
                setDataUid("local");
                try { await applyLocalLibrary({ notes: [], folders: [] }); } catch {}
            }
        }

        const alreadyBoundToNextAccount = Boolean(nextUid && activeLibraryUid === nextUid);
        if (!alreadyBoundToNextAccount) setDataUid("local");
        clearPrivateUnlock?.();

        return {
            changed: true,
            previousUid,
            nextUid,
            previousLibraryUid: activeLibraryUid,
            libraryUid: alreadyBoundToNextAccount ? nextUid : "local",
            restoredLocal: leavingAccountLibrary
        };
    };
}
