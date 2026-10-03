// Foundation-only boundary probe. It never opens user files or preferences.
#import <Foundation/Foundation.h>
#include <servers/bootstrap.h>
#include <unistd.h>
extern const int SANDBOX_CHECK_NO_REPORT;
extern int sandbox_check(pid_t, const char *, int, ...);
__attribute__((used, section("__TEXT,__info_plist"))) static const char info[] =
"<?xml version=\"1.0\"?><plist version=\"1.0\"><dict>"
"<key>CFBundleIdentifier</key><string>io.github.apple-notes-mcp.private-writer</string>"
"<key>CFBundleName</key><string>replica-isolation-probe</string></dict></plist>";
static BOOL denied(const char *operation, int filter, const char *value) {
  return sandbox_check(getpid(), operation, filter | SANDBOX_CHECK_NO_REPORT, value) == 1;
}
int main(void) {
  @autoreleasepool {
    const char *home = getenv("HOME"), *fixed = getenv("CFFIXED_USER_HOME");
    if (!home || !fixed || strcmp(home, fixed) == 0) return 90;
    NSString *realPreferences = [@(home) stringByAppendingPathComponent:@"Library/Preferences/io.github.apple-notes-mcp.private-writer.plist"];
    BOOL realHomeDenied = denied("file-read-data", 1, realPreferences.UTF8String) &&
      denied("file-write-data", 1, realPreferences.UTF8String) &&
      denied("file-write-create", 1, realPreferences.UTF8String);
    BOOL globalPreferencesDenied = denied("file-read-data", 1, "/Library/Preferences/.GlobalPreferences.plist") &&
      denied("file-write-data", 1, "/Library/Preferences/.GlobalPreferences.plist");
    BOOL preferencesDaemonDenied = YES;
    for (const char **name = (const char *[]){"com.apple.cfprefsd.agent", "com.apple.cfprefsd.daemon", NULL}; *name; name++) {
      mach_port_t port = MACH_PORT_NULL;
      kern_return_t result = bootstrap_look_up(bootstrap_port, *name, &port);
      preferencesDaemonDenied &= denied("mach-lookup", 2, *name) && result != KERN_SUCCESS && port == MACH_PORT_NULL;
    }
    BOOL networkDenied = denied("network-outbound", 0, NULL);
    NSString *observedHome = NSHomeDirectory();
    BOOL fixedUserHomeVerified = [[observedHome stringByStandardizingPath] isEqualToString:[@(fixed) stringByStandardizingPath]];
    BOOL productionBundleVerified = [[[NSBundle mainBundle] bundleIdentifier] isEqualToString:@"io.github.apple-notes-mcp.private-writer"];
    NSDictionary *receipt = @{ @"realHomeDenied": @(realHomeDenied), @"globalPreferencesDenied": @(globalPreferencesDenied),
      @"preferencesDaemonDenied": @(preferencesDaemonDenied), @"networkDenied": @(networkDenied),
      @"fixedUserHomeVerified": @(fixedUserHomeVerified), @"observedHome": observedHome, @"productionBundleVerified": @(productionBundleVerified) };
    NSData *json = [NSJSONSerialization dataWithJSONObject:receipt options:NSJSONWritingSortedKeys error:nil];
    fwrite(json.bytes, 1, json.length, stdout);
    fputc('\n', stdout);
    return realHomeDenied && globalPreferencesDenied && preferencesDaemonDenied && networkDenied &&
      fixedUserHomeVerified && productionBundleVerified ? 0 : 91;
  }
}
