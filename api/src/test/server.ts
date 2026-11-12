// Fake listeners must reserve the same IPv4 address used by their clients.
// An implicit localhost bind can coexist with another IPv4 listener on macOS.
export const TEST_SERVER_HOSTNAME = '127.0.0.1';
