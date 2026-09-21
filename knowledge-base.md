# Everfit BugBot Knowledge Base

_Generated: 2024-12-01_
_Covering: Last 12 months of issues from bug_reporting-internal, enterprise_bug_reporting_internal, and customer-request-discussion_

## Overview

- **Total Issues Analyzed**: 247 issues
- **Platforms**: iOS Client, iOS Coach, Android Client, Android Coach, Web, API
- **Time Period**: Last 12 months
- **Most Common Issues**: Sync failures, workout assignment, nutrition tracking, authentication

---

## Issues by Platform

### iOS Client (58 issues)

Most common problems:
- App crash on workout start (4 reports) → Update video streaming library
- Nutrition sync with MyFitnessPal failing (7 reports) → Check OAuth token expiration
- Push notification not received (5 reports) → Verify notification settings
- App freezes during heavy video playback (3 reports) → Optimize video buffering

### iOS Coach (42 issues)

Most common problems:
- Unable to assign multiple workouts batch (6 reports) → UI improvement needed
- Client data not syncing in real-time (4 reports) → Check WebSocket connection
- Video upload stalling (5 reports) → Improve upload with resumable chunks
- Dashboard performance degradation with 100+ clients (3 reports) → Optimize queries

### Android Client (51 issues)

Most common problems:
- Login fails on Android 11+ (8 reports) → Fix OAuth flow for new Android versions
- Fitness tracker sync interrupted (6 reports) → Implement exponential backoff retry
- App crashes on low memory (4 reports) → Memory optimization needed
- Notification badges not clearing (3 reports) → Fix notification management

### Android Coach (35 issues)

Most common problems:
- App crashes when opening large program (5 reports) → Pagination needed for programs
- Chat messages disappearing (4 reports) → Database transaction issue
- Video playback lag on 4G (3 reports) → Adaptive bitrate implementation
- Form submission timeout (2 reports) → Add form state persistence

### Web (38 issues)

Most common problems:
- Dashboard slow with 1000+ data points (5 reports) → Implement data sampling
- Chart rendering causing UI freeze (4 reports) → Use canvas instead of SVG
- Export to PDF failing for large data (3 reports) → Stream PDF generation
- Meal plan calendar not loading (2 reports) → Cache calendar data

### API (23 issues)

Most common problems:
- Batch operation timeouts (4 reports) → Implement queue-based processing
- Rate limiting errors on sync (3 reports) → Adjust rate limits for heavy users
- Data consistency issues after crash (2 reports) → Improve transaction handling
- Integration webhook delivery failures (2 reports) → Add retry mechanism

---

## Issues by Type

### Login & Auth (35 issues)

**Pattern**: Authentication failures spike during app updates

**Resolution Steps**:
1. Ask user to log out completely and clear app cache
2. Force close the app and restart device
3. Check if user's account is verified in admin
4. If on Android 11+, verify OAuth consent screen flow
5. Check Apple Health/Google Health permissions on mobile
6. Review auth service logs for session expiration issues
7. If still failing, reset user session from admin panel

**Recent Examples**:
- OAuth token expiration causing login failures
- Session timeout on WebSocket disconnect
- Biometric auth failing after app update

### Workout Management (42 issues)

**Pattern**: Workout assignment fails during peak hours (high server load)

**Resolution Steps**:
1. Verify workout exists in the system and not deleted
2. Check if client has accepted previous assignment
3. Verify client is still in the coach's workspace
4. Check video upload status if it's a video workout
5. Try reassigning from web dashboard
6. If bulk assignment, try assigning to single client first
7. Check server load during peak hours

**Recent Examples**:
- Workout video not transcoding properly (API queue backed up)
- Assignment notification not received by client
- Workout description with special characters causing encoding issues

### Nutrition (38 issues)

**Pattern**: Meal logging issues spike when external integrations are down

**Resolution Steps**:
1. Check if MyFitnessPal/Cronometer service is accessible
2. Verify user's API credentials for external service
3. Ask user to re-authenticate with MyFitnessPal
4. Check if meal plan is properly assigned
5. Verify food database is up to date
6. For sync issues, try manual refresh first
7. Check if user's subscription covers integration feature

**Recent Examples**:
- MyFitnessPal rate limiting blocking meal sync
- Meal plan not visible after assignment (permissions issue)
- Calorie calculation showing incorrect values (DB precision issue)

### Account & Profile (31 issues)

**Pattern**: Email change requests require backend data fix + CS coordination

**Resolution Steps** (2-ticket approach):
- **Task 1**: [Client Report][API][Fix data][Account] Update user email in database
- **Task 2**: [Client Report][API][Account] Verify email verification flow
  1. Verify email not already associated with another account
  2. Update email in auth system
  3. Send new verification email
  4. Check email delivery logs
  5. Verify user can log in with new email

**Recent Examples**:
- Coach unable to change workspace subscription tier
- Client profile data not updating across platforms
- Team member access permission stuck after removal

### Payment (18 issues)

**Pattern**: Subscription issues during renewal period

**Resolution Steps**:
1. Check payment gateway (Stripe/PayPal) status
2. Verify subscription status in database
3. Ask user to check email for billing statement
4. Check if billing card is expired
5. If payment declined, ask user to update payment method
6. For coaching software subscriptions, coordinate with CS
7. Escalate to payment team for failed refund requests

**Recent Examples**:
- Subscription renewal failed but account still marked paid
- Coach still charged after cancellation
- Invoice showing wrong amount due to currency conversion

### Sync Issues (29 issues)

**Pattern**: Sync fails when user has poor internet or API is degraded

**Resolution Steps**:
1. Verify user has stable internet connection
2. Ask user to toggle airplane mode and retry
3. Force app refresh/pull-to-refresh
4. Clear app cache and try again
5. Check API server logs for timeout errors
6. For health app sync, re-authenticate with Apple/Google Health
7. If sync conflict detected, use server version as truth

**Recent Examples**:
- Workout data stuck in "syncing" state
- Health metrics from Apple Health not updating
- Nutrition data sync delayed by 30+ minutes

### UI/UX (24 issues)

**Pattern**: Layout issues on specific screen sizes or orientations

**Resolution Steps**:
1. Test on the reported device and OS version
2. Check if issue reproduces in staging
3. Test both portrait and landscape orientations
4. Clear cache and test again
5. Check if CSS is properly responsive
6. Verify font loading from CDN
7. For web, check browser console for errors

**Recent Examples**:
- Buttons overlapping on iPad in landscape
- Text truncation in non-English languages
- Color contrast issues affecting accessibility

### Performance (21 issues)

**Pattern**: Performance degrades with large datasets

**Resolution Steps**:
1. Monitor network latency and API response times
2. Check server CPU and memory usage
3. Review database query performance
4. For app, check memory usage and garbage collection
5. Implement pagination or lazy loading if needed
6. Consider data caching strategy
7. Use profiling tools to identify bottlenecks

**Recent Examples**:
- Dashboard loads 10+ seconds with 5000+ data points
- App memory leak causing crash after 1 hour usage
- API endpoint timeout with large batch requests

### Data Issues (17 issues)

**Pattern**: Data corruption or loss after server crash or migration

**Resolution Steps**:
1. Check database backups for latest clean snapshot
2. Run data integrity checks
3. Review transaction logs around incident time
4. If data is lost, restore from backup if available
5. Notify affected users of data recovery status
6. Implement better data validation on insert/update
7. Add monitoring for data anomalies

**Recent Examples**:
- Client workout history deleted after account merge
- Nutrition macros showing NaN values
- User profile fields reset to defaults

---

## Squad Mapping for Issues

### Core Product - Training & Automation
- **SM**: Thanh Ngo | **PC**: Duyen Tran | **BA**: Ngoc Nguyen
- **Domains**: Workout Assignment, Video Workout, Training Tracking, Autoflow
- **Recent Issues**: Video transcoding delays, batch assignment failures, autoflow trigger bugs
- **Escalation Path**: Report in #bug_reporting-internal → Squad lead decides → Backend/Frontend/QA

### Core Product - Nutrition
- **SM**: Bao Ho | **PC**: Anh Le | **BA**: Dung Pham
- **Domains**: Meal Plans, Nutrition Tracking, Macros, External Integrations
- **Recent Issues**: MyFitnessPal sync timeouts, meal plan visibility, macro calculation errors
- **Escalation Path**: Check if integration issue → Coordinate with integration squad → Backend fixes

### Core Product - Engagement
- **SM**: Bao Ho | **PC**: Anh Le | **BA**: Sally Phan
- **Domains**: Client Communication, Check-ins, Forms, Client Onboarding
- **Recent Issues**: Chat sync delays, form submission timeouts, check-in notification failures
- **Escalation Path**: Reproduce in staging → Backend investigation → Data sync analysis

### Core Product - Platform Capability
- **SM**: Thanh Ngo | **PC**: Ngoc Nguyen | **BA**: Dieu Kieu
- **Domains**: Authentication, Workspace Management, Localization, Permissions
- **Recent Issues**: OAuth flow for new Android versions, session management, permission system
- **Escalation Path**: Auth service logs → Backend fixes → Cross-platform testing

### Core Product - Integration & Middleware
- **SM**: Thanh Ngo | **PC**: Nhi Bien | **BA**: Sally Phan
- **Domains**: External Integrations (Apple Health, MyFitnessPal, etc.), Data Middleware
- **Recent Issues**: Webhook delivery failures, rate limiting, data transformation errors
- **Escalation Path**: External service status check → Integration debugging → Data pipeline fixes

---

## Common Resolution Patterns

### For iOS/Android Issues:
```
1. Get device info: Model, OS version, app version
2. Ask to: Force close → Clear cache → Restart device → Retry
3. If still fails: Uninstall and reinstall latest app version
4. For crashes: Collect crash logs from device
5. For performance: Monitor memory and battery usage
```

### For Web Issues:
```
1. Get browser info: Type, version, resolution
2. Ask to: Clear cache → Try private/incognito mode → Try different browser
3. Check browser console for JavaScript errors
4. If CSS issue: Verify responsive design at reported resolution
5. For export/download: Check file system permissions
```

### For Authentication Issues:
```
1. Verify account status in admin (active/suspended/deleted)
2. Check if email is verified
3. For OAuth: Verify consent screen approval
4. Check session storage and cookie settings
5. Review auth service logs for failed attempts
6. If multi-factor: Verify 2FA method is accessible
```

### For API/Data Issues:
```
1. Check API health dashboard
2. Review server logs for errors at reported time
3. Verify database connectivity and query performance
4. Check for rate limiting or resource limits
5. Review recent deployments for breaking changes
6. Collect: Exact timestamp, affected user IDs, request payloads
```

### For Integration Issues:
```
1. Verify external service status (e.g., Apple Health, MyFitnessPal)
2. Check OAuth tokens haven't expired
3. Review webhook delivery logs
4. Check API rate limits with external service
5. Test connectivity to external service
6. Verify webhook signatures are correct
```

---

## Priority Matrix for Quick Decisions

| Impact | Effort | Priority | Example |
|---|---|---|---|
| High | Low | **Highest** | Fix app crash with 1-line code change |
| High | High | **High** | Add missing authentication validation |
| Medium | Low | **High** | Fix typo in critical user message |
| Medium | Medium | **Medium** | Improve API pagination performance |
| Low | Low | **Medium** | Fix button spacing on edge screen size |
| High | Very High | **High** | Rewrite API for scalability |
| Low | Medium | **Low** | Cosmetic UI improvements |
| Low | High | **Lowest** | Complex internal refactoring |

---

## Emergency Response Checklist

**When issue is reported as "Urgent" or "Production Down":**

1. ☐ Check current system status dashboard
2. ☐ Verify if issue is widespread or account-specific
3. ☐ If widespread: Declare incident and notify all squads
4. ☐ Get logs from the exact time issue occurred
5. ☐ Check recent deployments in that area
6. ☐ If production data issue: Pause automated processes to prevent spread
7. ☐ Communicate ETA to affected users via Intercom
8. ☐ After fix: Post-mortem to prevent recurrence

---

## How to Use This Knowledge Base

1. **When BugBot analyzes a new issue**, it includes this KB in the system prompt
2. **BugBot suggests resolution steps** based on historical patterns
3. **Auto-classifies the issue** to the correct squad
4. **Tags SM/PC of responsible squad** for visibility
5. **Recommends priority** based on impact/effort matrix

**Update this KB by running:**
```bash
node knowledge-base-builder.js
```

This scans the last 12 months of issues from all monitored channels and updates patterns.

---

## Related Documents

- [Squad Separation Document](./squad-separation.md) - Domain breakdown by squad
- [Squad Roster](./squad-roster.xlsx) - Team members and contact info
- [Jira Project Structure](https://everfit.atlassian.net/browse/UP) - Issue tracking
- [System Architecture](./architecture.md) - Tech stack and APIs
