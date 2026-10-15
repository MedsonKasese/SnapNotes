export function createCloudSessionGuard() {
    let generation = 0;
    let uid = null;
    let requestGeneration = 0;

    return {
        advance(nextUid) {
            generation += 1;
            uid = nextUid || null;
            return generation;
        },
        capture(expectedUid) {
            requestGeneration += 1;
            return { uid: expectedUid || null, generation, requestGeneration };
        },
        isCurrent(snapshot, activeUid) {
            return Boolean(snapshot && snapshot.uid && uid === snapshot.uid &&
                activeUid === snapshot.uid && generation === snapshot.generation &&
                requestGeneration === snapshot.requestGeneration);
        },
        get generation() { return generation; }
    };
}
