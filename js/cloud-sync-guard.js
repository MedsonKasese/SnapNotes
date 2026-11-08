export function isLibraryBoundToUser(activeLibraryUid, userUid) {
    if (!userUid) return false;
    return activeLibraryUid === userUid;
}

export function rootSnapshotBelongsToLibrary(rootLibraryUid, libraryUid) {
    return rootLibraryUid === null || rootLibraryUid === undefined || rootLibraryUid === libraryUid;
}

export function shouldSyncPendingChanges({ uid, authUid, activeLibraryUid, online, pending }) {
    return Boolean(
        uid &&
        uid === authUid &&
        isLibraryBoundToUser(activeLibraryUid, uid) &&
        online &&
        pending
    );
}
