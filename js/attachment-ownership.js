export function isAttachmentOwnedByUser(ownerUid, userUid) {
    return typeof ownerUid === "string" && ownerUid.length > 0 && ownerUid === userUid;
}

export function canRetryAttachmentUploads(activeLibraryUid, userUid) {
    return typeof userUid === "string" && userUid.length > 0 && activeLibraryUid === userUid;
}
