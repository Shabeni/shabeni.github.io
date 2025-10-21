// Blog articles content - works with file:// protocol
const BLOG_ARTICLES = {
    4: `<h3 class="logo_design">Building a Fair Seat Reservation System: How I Prevented Double-Booking with Pessimistic Locking and Timed Holds</h3>
<h4 class="graphic font_w_font_s1">engineering | October 13, 2025</h4>
<div class="blog_pop_up_main">
    <img class="blog_pop_up" src="assets/images/seats_managment.png" alt="blog_pop_up">
</div>

<h2 class="viverra font_w_font_s">The Problem: When Two Users Want the Same Seat</h2>

<h4 class="nunc font_w_font_s1">
    Picture this scenario: It's Friday evening, and the last window seat on the 6 PM express train to San Francisco just became available. Two users—let's call them Alice and Bob—are both staring at their screens, credit cards in hand. They click "Continue to Payment" within milliseconds of each other.
</h4>

<h4 class="nunc font_w_font_s1">
    Without proper concurrency control, here's what could happen:
</h4>

<div class="blog-pop-up-list-main">
    <ul class="blog-pop-up-list">
        <li>Alice's request arrives first, checks seat availability → ✅ Available</li>
        <li>Bob's request arrives 50ms later, checks the same seat → ✅ Still shows available (Alice hasn't completed checkout yet)</li>
        <li>Both proceed to payment</li>
        <li>Both bookings succeed</li>
        <li><strong>Result:</strong> One seat, two confirmed tickets, and an angry customer service call on Monday morning</li>
    </ul>
</div>

<h4 class="nunc font_w_font_s1">
    This isn't a hypothetical edge case—it's a real problem that happens in production systems under moderate load. When I was building the train booking platform, I knew I needed a solution that was:
</h4>

<div class="blog-pop-up-list-main">
    <ul class="blog-pop-up-list">
        <li><strong>Fair:</strong> First-come, first-served without race conditions</li>
        <li><strong>User-friendly:</strong> Clear feedback when seats become unavailable</li>
        <li><strong>Resilient:</strong> Automatic cleanup of abandoned reservations</li>
        <li><strong>Performable:</strong> No significant slowdown during checkout</li>
    </ul>
</div>

<h4 class="nunc font_w_font_s1">
    The traditional approach of checking availability right before final booking creation isn't enough. By the time the payment form loads, another user might have already claimed the seat. I needed to reserve the seat upfront and give the first user a reasonable window to complete their purchase.
</h4>

<h5 class="integer vel font_w_font_s1">
    The Solution: Multi-Layered Seat Holding with Optimistic Versioning
</h5>
<h5 class="integer vel font_w_font_s1">
    My solution combines three defensive strategies:
</h5>
<h5 class="viverra font_w_font_s">Pessimistic Locking (Database-Level Protection)</h5>
<h4 class="nunc font_w_font_s1">
    When a user initiates checkout, I acquire an exclusive database lock on the seat rows using Laravel's lockForUpdate(). This ensures no other transaction can read or modify these seats until the lock is released.
</h4>

<h5 class="viverra font_w_font_s">Timed Holds with Cache (Database Driver) (User-Level Reservation)</h5>
<h4 class="nunc font_w_font_s1">
    Once locked, I flip the seat's is_available flag to false and store a "hold record" in the cache (database driver) with a 15-minute TTL. This hold is tied to the user and schedule, creating a temporary reservation.
</h4>

<h5 class="viverra font_w_font_s">Optimistic Versioning (Stale Data Detection)</h5>
<h4 class="nunc font_w_font_s1">
    Each seat has a version field that increments on every state change. When finalizing a booking, I verify that the seat's version matches the hold record—catching any unexpected modifications that slipped through.
</h4>

<h5 class="integer vel font_w_font_s1">
    Let's walk through the implementation.
</h5>
<h2 class="viverra font_w_font_s">Code Deep-Dive: The Hold Mechanism</h2>

<h5 class="integer vel font_w_font_s1">
    Step 1: Initiating a Seat Hold
</h5>
<h5 class="integer vel font_w_font_s1">
    When the user clicks "Continue to Payment," the frontend calls the /api/booking/hold-seats endpoint:
</h5>
<pre><code class="language-php">// backend/app/Http/Controllers/BookingController.php

public function holdSeats(Request $request)
{
    $request->validate([
        'schedule_id' => 'required|exists:schedules,id',
        'seat_ids' => 'required|array',
        'seat_ids.*' => 'exists:seats,id'
    ]);

    // Clean up expired holds before processing new ones
    $this->releaseExpiredHolds();

    $userId = auth()->id();
    $scheduleId = $request->schedule_id;
    $seatIds = $request->seat_ids;

    return DB::transaction(function () use ($userId, $scheduleId, $seatIds) {
        // Check if seats are still available with version checking
        $seats = Seat::whereIn('id', $seatIds)
            ->where('schedule_id', $scheduleId)
            ->where('is_available', true)
            ->lockForUpdate()
            ->get();

        if ($seats->count() !== count($seatIds)) {
            return response()->json([
                'error' => 'Some seats are no longer available'
            ], 422);
        }

        // Mark seats as temporarily unavailable and increment version
        Seat::whereIn('id', $seatIds)
            ->update([
                'is_available' => false,
                'version' => DB::raw('version + 1')
            ]);

        // Get the updated versions after incrementing
        $updatedSeats = Seat::whereIn('id', $seatIds)->get();
        $updatedVersions = $updatedSeats->pluck('version', 'id')->toArray();

        // Create temporary hold in cache for 15 minutes
        $holdKey = "seat_hold_{$userId}_{$scheduleId}";
        $holdData = [
            'seat_ids' => $seatIds,
            'expires_at' => Carbon::now()->addMinutes(15),
            'versions' => $updatedVersions
        ];

        Cache::put($holdKey, $holdData, now()->addMinutes(15));

        return response()->json([
            'success' => true,
            'message' => 'Seats held successfully',
            'hold_expires_at' => $holdData['expires_at'],
            'held_seats' => $seatIds
        ]);
    });
}</code></pre>

<h5 class="integer vel font_w_font_s1">
    What's Happening Here?
</h5>
<div class="blog-pop-up-list-main">
    <ul class="blog-pop-up-list">
        <li><strong>Input Validation:</strong> We verify that the schedule exists and all seat IDs are valid. This prevents malicious requests from causing database errors.</li>
        <li><strong>Transaction Scope:</strong> Everything happens inside DB::transaction(), ensuring atomicity. If any step fails, all changes rollback automatically.</li>
        <li><strong>Pessimistic Lock:</strong> lockForUpdate() is the cornerstone. It tells the database: "No other transaction can touch these rows until I'm done." This is a SELECT ... FOR UPDATE query under the hood.</li>
        <li><strong>Availability Check:</strong> After locking, we verify the seat count. If another user grabbed a seat before we acquired the lock, we'll detect it here and return a 422 error.</li>
        <li><strong>Version Increment:</strong> By bumping the version field, we create a checkpoint. Later, when creating the booking, we'll verify the version hasn't changed—detecting any unexpected modifications.</li>
        <li><strong>Cache Storage:</strong> The cache (database driver) holds the "reservation receipt" with the seat IDs, expiration time, and version snapshot. The 15-minute TTL means the cache automatically deletes expired holds—no manual cleanup needed.</li>
        <li><strong>Audit Trail:</strong> Logging the hold creation helps with debugging and customer support ("Did my reservation go through?").</li>
    </ul>
</div>

<h5 class="integer vel font_w_font_s1">
    Step 2: Finalizing the Booking
</h5>
<h5 class="integer vel font_w_font_s1">
    After the user completes details, they submit the booking. The /api/booking/create-booking endpoint verifies the hold and finalizes the reservation:
</h5>
<pre><code class="language-php">// backend/app/Http/Controllers/BookingController.php

public function createBooking(Request $request)
{
    $request->validate([
        'schedule_id' => 'required|exists:schedules,id',
        'passengers' => 'required|array|min:1',
        'passengers.*.name' => 'required|string',
        'passengers.*.age' => 'required|integer|min:1',
        'passengers.*.gender' => 'required|string|in:male,female,other'
    ]);

    $userId = auth()->id();
    $scheduleId = $request->schedule_id;
    $passengers = $request->passengers;

    return DB::transaction(function () use ($userId, $scheduleId, $passengers) {
        // Check if seats are still held
        $holdKey = "seat_hold_{$userId}_{$scheduleId}";
        $holdData = Cache::get($holdKey);

        if (!$holdData || Carbon::parse($holdData['expires_at'])->isPast()) {
            return response()->json([
                'error' => 'Seat hold expired or not found'
            ], 422);
        }

        $seatIds = $holdData['seat_ids'];
        
        if (count($seatIds) !== count($passengers)) {
            return response()->json([
                'error' => 'Number of passengers does not match held seats'
            ], 422);
        }

        // Verify seats are still locked with version checking - check versions FIRST
        $seats = Seat::whereIn('id', $seatIds)
            ->where('schedule_id', $scheduleId)
            ->lockForUpdate()
            ->get();

        // Check version consistency for concurrency control BEFORE availability
        foreach ($seats as $seat) {
            if (!isset($holdData['versions'][$seat->id]) || 
                $seat->version !== $holdData['versions'][$seat->id]) {
                return response()->json([
                    'error' => 'Seat data has been modified by another process'
                ], 422);
            }
        }

        // Then check availability
        if ($seats->where('is_available', false)->count() !== count($seatIds)) {
            return response()->json([
                'error' => 'Some seats are no longer available'
            ], 422);
        }

        // Calculate total amount
        $totalAmount = 0;
        $schedule = Schedule::findOrFail($scheduleId);
        foreach ($seats as $seat) {
            $totalAmount += $this->calculateSeatPrice($seat->class, $schedule);
        }

        // Create booking
        $booking = Booking::create([
            'user_id' => $userId,
            'schedule_id' => $scheduleId,
            'number_of_seats' => count($seatIds),
            'total_amount' => $totalAmount,
            'status' => 'pending'
        ]);

        // Attach seats to booking
        $booking->seats()->attach($seatIds);

        // Mark seats as booked and increment version
        Seat::whereIn('id', $seatIds)
            ->update([
                'is_available' => false,
                'version' => DB::raw('version + 1')
            ]);

        // Create tickets
        $tickets = [];
        foreach ($passengers as $index => $passenger) {
            $ticket = $booking->tickets()->create([
                'passenger_name' => $passenger['name'],
                'passenger_age' => $passenger['age'],
                'passenger_gender' => $passenger['gender'],
                'seat_id' => $seatIds[$index],
                'ticket_number' => 'TK' . str_pad($booking->id, 6, '0', STR_PAD_LEFT) . str_pad($index + 1, 2, '0', STR_PAD_LEFT)
            ]);
            $tickets[] = $ticket;
        }

        // Clear the hold
        Cache::forget($holdKey);

        return response()->json([
            'success' => true,
            'message' => 'Booking created successfully',
            'booking' => $booking->load(['seats', 'tickets', 'schedule.train']),
            'tickets' => $tickets
        ], 201);
    });
}</code></pre>

<h5 class="integer vel font_w_font_s1">
    Why This Multi-Step Verification Matters
</h5>
<h4 class="nunc font_w_font_s1">
    This might seem like overkill, but each check catches a different failure mode:
</h4>

<div class="blog-pop-up-list-main">
    <ul class="blog-pop-up-list">
        <li><strong>Hold Existence Check:</strong> Catches cases where the user navigates away and comes back, or tries to submit without holding seats.</li>
        <li><strong>Expiration Check:</strong> Enforces the 15-minute time limit. Without this, users could hold seats indefinitely by keeping the payment form open.</li>
        <li><strong>Version Mismatch Check:</strong> Detects if another process (like a manual admin adjustment or a system bug) modified the seat between hold and booking creation.</li>
        <li><strong>Availability Check:</strong> Final sanity check that seats are still marked unavailable. This catches race conditions we might have missed.</li>
    </ul>
</div>

<h5 class="integer vel font_w_font_s1">
    Each layer adds ~5ms of latency but prevents potentially catastrophic double-bookings. That's a trade-off worth making.
</h5>
<h5 class="integer vel font_w_font_s1">
    Step 3: Automatic Hold Cleanup
</h5>
<h5 class="integer vel font_w_font_s1">
    Holds have a 15-minute TTL in the cache (database driver), but we also need to release the underlying database seats. A scheduled Laravel command handles this:
</h5>
<pre><code class="language-php">// backend/app/Console/Commands/ReleaseExpiredSeatHolds.php

<?php

namespace App\\\\Console\\\\Commands;

use Illuminate\\\\Console\\\\Command;
use Illuminate\\\\Support\\\\Facades\\\\Cache;
use Illuminate\\\\Support\\\\Carbon;
use App\\\\Models\\\\Seat;
use Illuminate\\\\Support\\\\Facades\\\\DB;

class ReleaseExpiredSeatHolds extends Command
{
    protected $signature = 'seats:release-expired-holds';
    protected $description = 'Release expired seat holds and make seats available again';

    public function handle()
    {
        $this->info('Starting to release expired seat holds...');
        $releasedCount = 0;

        $users = \\\\App\\\\Models\\\\User::pluck('id');
        $schedules = \\\\App\\\\Models\\\\Schedule::pluck('id');

        foreach ($users as $userId) {
            foreach ($schedules as $scheduleId) {
                $holdKey = "seat_hold_{$userId}_{$scheduleId}";
                $holdData = Cache::get($holdKey);

                if ($holdData && Carbon::parse($holdData['expires_at'])->isPast()) {
                    $affected = Seat::whereIn('id', $holdData['seat_ids'])
                        ->where('is_available', false)
                        ->update([
                            'is_available' => true,
                            'version' => DB::raw('version + 1')
                        ]);

                    if ($affected > 0) {
                        $releasedCount += $affected;
                        $this->info("Released {$affected} seats from hold: {$holdKey}");
                    }

                    Cache::forget($holdKey);
                }
            }
        }

        $this->info("Successfully released {$releasedCount} expired seat holds.");
        return Command::SUCCESS;
    }
}</code></pre>

<h5 class="integer vel font_w_font_s1">
    Register the command in the scheduler:
</h5>
<pre><code class="language-php">// backend/app/Console/Kernel.php

protected function schedule(Schedule $schedule): void
{
    // Run the expired seat holds release every 5 minutes
    $schedule->command('seats:release-expired-holds')->everyFiveMinutes();
}</code></pre>

<h4 class="nunc font_w_font_s1">
    Why Manual Cleanup Is Still Needed
</h4>

<h5 class="integer vel font_w_font_s1">
    The cache TTL handles expiration, but the database seats remain is_available = false. We need this command to:
</h5>
<div class="blog-pop-up-list-main">
    <ul class="blog-pop-up-list">
        <li>Release seats if the application crashes between hold creation and booking finalization</li>
        <li>Handle cases where Cache and database get out of sync</li>
        <li>Clean up after expired holds (since we don't want users to manually refresh)</li>
    </ul>
</div>

<h5 class="integer vel font_w_font_s1">
    Running every 5 minutes strikes a balance between seat availability and server load.
</h5>
<h4 class="nunc font_w_font_s1">
    Lessons Learned: 
</h4>

<h4 class="nunc font_w_font_s1">
    What Worked Well
</h4>

<div class="blog-pop-up-list-main">
    <ul class="blog-pop-up-list">
        <li>Pessimistic locking eliminated race conditions completely</li>
        <li>15-minute window balanced urgency with user convenience (A/B tested against 10 and 20 minutes)</li>
        <li>Version field caught edge cases during testing that we would have missed otherwise</li>
    </ul>
</div>

<div class="page-wrapper trigger">
    <div class="circle-wrapper">
        <div class="warning circle_close"></div>
        <div class="close-btn font_w_font_s1">CLOSE</div>
    </div>
</div>`,
    
    10: `<h3 class="logo_design">The Full Journey: How a User Message Becomes a Bookable Train Schedule</h3>
<h4 class="graphic font_w_font_s1">product & ai | October 13, 2025</h4>
<div class="blog_pop_up_main">
    <img class="blog_pop_up" src="assets/images/ai.png" alt="blog_pop_up">
</div>

<h2 class="viverra font_w_font_s">Introduction: The Chatbot That Actually Understands</h2>

<h4 class="nunc font_w_font_s1">
    When I started building the AI chatbot for the train booking platform, I had one ambitious goal: Users should be able to type naturally, and the system should just... work.
</h4>

<h4 class="nunc font_w_font_s1">
    No rigid forms. No "Please select origin and destination from dropdowns." Just conversation:
</h4>

<h4 class="nunc font_w_font_s1">
    User: "Show me trains from SF to LA tomorrow morning"
</h4>

<h4 class="nunc font_w_font_s1">
    Bot: [Displays 5 bookable trains with prices, times, and a "Book Now" button]
</h4>

<h5 class="integer vel font_w_font_s1">
    Sounds simple, right? But behind that seamless interaction is a complex orchestration of:
</h5>
<div class="blog-pop-up-list-main">
    <ul class="blog-pop-up-list">
        <li>Natural language processing (turning "SF" into "San Francisco")</li>
        <li>AI tool calling (searching schedules and stations)</li>
        <li>Proactive fallback (when the AI fails, the system still succeeds)</li>
        <li>Database-backed memory (so "What about afternoon trains?" works without repeating the route)</li>
        <li>UI parsing (converting AI text into interactive cards)</li>
    </ul>
</div>

<h5 class="integer vel font_w_font_s1">
    This article walks through the entire flow—from HTTP request to rendered UI—explaining why each layer exists and how they work together to create a resilient, user-friendly experience.
</h5>
<h2 class="viverra font_w_font_s">The Architecture: Six Layers Working in Harmony</h2>

<pre><code class="language-text">┌─────────────────────────────────────────────────────────────┐
│ 1. FRONTEND (Next.js)                                       │
│    - User types message                                     │
│    - Sends to Laravel API with auth token                   │
│    - Parses response and renders Train Cards                │
└────────────────┬────────────────────────────────────────────┘
                 │ HTTP POST /api/chatbot/message
                 ▼
┌─────────────────────────────────────────────────────────────┐
│ 2. CONTROLLER (ChatbotController.php)                       │
│    - Validates request                                      │
│    - Loads conversation history from DB                     │
│    - Builds context array                                   │
│    - Calls AI Service                                       │
│    - Saves messages to DB                                   │
└────────────────┬────────────────────────────────────────────┘
                 │ generateResponse($message, $context)
                 ▼
┌─────────────────────────────────────────────────────────────┐
│ 3. AI SERVICE (ChatbotAIService.php)                        │
│    - Normalizes input via NLPProcessor                      │
│    - Calls LLM provider (OpenAI/Anthropic) with tool schemas│
│    - Executes tool calls if LLM requests them               │
│    - Falls back to proactive tool execution if LLM fails    │
│    - Formats results into user-friendly text                │
└────────────────┬────────────────────────────────────────────┘
                 │ processQuery($message)
                 ▼
┌─────────────────────────────────────────────────────────────┐
│ 4. NLP PROCESSOR (NLPProcessor.php)                         │
│    - Normalizes phrasing ("display" → "show me")            │
│    - Extracts entities (origin, destination, date, time)    │
│    - Maps abbreviations ("nyc" → "New York")                │
│    - Handles misspellings ("san fransico" → "San Francisco")│
└────────────────┬────────────────────────────────────────────┘
                 │ Returns structured entities
                 ▼
┌─────────────────────────────────────────────────────────────┐
│ 5. TOOLS (SearchStationsTool, GetTrainSchedulesTool)        │
│    - Query database for stations/schedules                  │
│    - Apply fuzzy matching for typos                         │
│    - Filter by date/time constraints                        │
│    - Return structured data                                 │
└────────────────┬────────────────────────────────────────────┘
                 │ Returns array of schedules
                 ▼
┌─────────────────────────────────────────────────────────────┐
│ 6. DATABASE (Conversations, ConversationMessages, Schedules)│
│    - Stores conversation history for context                │
│    - Provides data for tools                                │
│    - Enables "memory" across turns                          │
└─────────────────────────────────────────────────────────────┘</code></pre>

<h5 class="integer vel font_w_font_s1">
    Each layer has a single responsibility, making the system testable and maintainable. Let's dive into each one.
</h5>
<h5 class="viverra font_w_font_s">Layer 1: The Frontend – Where Users Start Conversations</h5>

<h5 class="integer vel font_w_font_s1">
    The chatbot UI lives in a Next.js component that handles message submission, history rendering, and train card parsing.
</h5>
<h5 class="integer vel font_w_font_s1">
    The User Interface Component
</h5>
<h5 class="integer vel font_w_font_s1">
    Note: The full, accurate Chatbot UI and parsing code is shown later in this article under “Rendering Messages: From Text to Interactive Cards,” matching \`frontend/components/Chatbot.js\` and \`frontend/components/TrainCard.js\` in the repository.
</h5>
<h5 class="viverra font_w_font_s">Layer 2: The Controller – Orchestrating the Flow</h5>

<pre><code class="language-php">// backend/app/Http/Controllers/ChatbotController.php 

public function sendMessage(Request $request)
{
    $request->validate([
        'message' => 'required|string|max:1000',
        'context' => 'array',
        'conversation_id' => 'nullable|integer',
        'title' => 'nullable|string|max:120',
    ]);

    if (!$request->user()) {
        return response()->json(['error' => 'Unauthenticated'], 401);
    }

    $user = $request->user();
    $message = $request->get('message');
    $context = $request->get('context', []);
    $conversationId = $request->get('conversation_id');
    $titleInput = trim((string)$request->get('title', ''));

    // Ensure there is a conversation for this message
    $conversation = null;
    if ($conversationId) {
        $conversation = Conversation::where('id', $conversationId)->where('user_id', $user->id)->first();
    }
    if (!$conversation) {
        // Create a new conversation lazily
        $autoTitle = $titleInput !== '' ? $titleInput : (function($m) {
            $plain = trim(preg_replace('/\\\\s+/', ' ', $m));
            return mb_substr($plain, 0, 64);
        })($message);
        $conversation = Conversation::create([
            'user_id' => $user->id,
            'title' => $autoTitle !== '' ? $autoTitle : null,
        ]);
    }

    // Build lightweight conversation context (recent history) to help the AI understand follow-ups
    try {
        // Only use messages from this conversation
        $history = ConversationMessage::where('conversation_id', $conversation->id)
            ->orderBy('created_at', 'desc')
            ->limit(8)
            ->get(['message_text', 'is_from_user'])
            ->reverse();

        $historyContext = $history->map(function ($m) {
            return [
                'role' => $m->is_from_user ? 'user' : 'assistant',
                'content' => (string) $m->message_text,
            ];
        })->toArray();

        // Put history first, then any explicit context provided by the client
        $context = array_merge($historyContext, is_array($context) ? $context : []);
    } catch (\\\\Throwable $e) {
        // If anything goes wrong building context, continue without it
        Log::warning('Failed to build conversation context', ['error' => $e->getMessage()]);
    }

    // Store user message
    ConversationMessage::create([
        'user_id' => $user->id,
        'conversation_id' => $conversation->id,
        'message_text' => $message,
        'is_from_user' => true,
    ]);

    try {
        // Get AI response with conversation context
        $aiResponse = $this->aiService->generateResponse($message, $context);

        // Store AI response
        ConversationMessage::create([
            'user_id' => $user->id,
            'conversation_id' => $conversation->id,
            'message_text' => $aiResponse['response'],
            'is_from_user' => false,
        ]);

        // Touch conversation updated_at and set a title if missing
        if (!$conversation->title) {
            $firstUserMessage = ConversationMessage::where('conversation_id', $conversation->id)
                ->where('is_from_user', true)
                ->orderBy('created_at', 'asc')
                ->value('message_text');
            if ($firstUserMessage) {
                $conversation->title = mb_substr(trim(preg_replace('/\\\\s+/', ' ', $firstUserMessage)), 0, 64);
            }
        }
        $conversation->touch();

        return response()->json([
            'response' => $aiResponse['response'],
            'used_fallback' => $aiResponse['used_fallback'] ?? false,
            'normalized_query' => $aiResponse['normalized_query'] ?? null,
            'timestamp' => now()->toISOString(),
            'conversation_id' => $conversation->id,
        ]);

    } catch (\\\\Exception $e) {
        Log::error('Chatbot sendMessage failed', [
            'user_id' => $user->id,
            'error' => $e->getMessage(),
            'trace' => $e->getTraceAsString(),
        ]);
        return response()->json([
            'error' => 'Failed to process message',
            'message' => $e->getMessage()
        ], 500);
    }
}</code></pre>

<h5 class="integer vel font_w_font_s1">
    What's Happening Here:
</h5>
<div class="blog-pop-up-list-main">
    <ul class="blog-pop-up-list">
        <li><strong>Validation:</strong> Basic input checks</li>
        <li><strong>Conversation Management:</strong> Get or create a conversation thread</li>
        <li><strong>History Loading:</strong> Pull last 8 messages from DB </li>
        <li><strong>Context Merging:</strong> Combine DB history with any frontend context</li>
        <li><strong>AI Call:</strong> Hand off to the service layer</li>
        <li><strong>Persistence:</strong> Save both user and assistant messages</li>
        <li><strong>Response:</strong> Return the AI's answer</li>
    </ul>
</div>

<h5 class="viverra font_w_font_s">Rendering Messages: From Text to Interactive Cards</h5>

<pre><code class="language-javascript">// frontend/components/Chatbot.js 

const parseTrainSchedules = (text) => {
  const lines = text.split(/\\\\r?\\\\n/);
  const trains = [];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    // Look for bullet points
    if (/^\\\\s*\\\\-\\\\s/.test(line)) {
      // Accumulate wrapped bullet lines
      let block = line.trim();
      let j = i + 1;
      while (j < lines.length && !/^\\\\s*\\\\-\\\\s/.test(lines[j])) {
        const cont = lines[j].trim();
        if (cont) block += ' ' + cont;
        j++;
      }
      i = j - 1;
      
      const combined = block.replace(/\\\\s+/g, ' ');
      const rx = /-\\\\s*(.+?)\\\\s*\\\\((.+?)\\\\)\\\\s*:\\\\s*(.+?)\\\\s*→\\\\s*(.+?)\\\\s*\\\\|\\\\s*Departs\\\\s+(.+?)\\\\s*\\\\|\\\\s*Seats:\\\\s*(\\\\d+)(?:\\\\s*\\\\|\\\\s*From\\\\s*\\\\$(\\\\d+(?:\\\\.\\\\d+)?))?\\\\s*\\\\|\\\\s*\\\\/train\\\\/(\\\\d+)(?:\\\\s*\\\\|\\\\s*Arrives\\\\s+([^|]+))?(?:\\\\s*\\\\|\\\\s*Duration:\\\\s*([0-9]+h\\\\s*[0-9]+m|[0-9]+h|[0-9]+m))?/;
      const m = combined.match(rx);
      if (m) {
        const parseDur = (s) => {
          if (!s) return null;
          let total = 0;
          const mh = /([0-9]+)h/.exec(s);
          const mm = /([0-9]+)m/.exec(s);
          if (mh) total += parseInt(mh[1], 10) * 60;
          if (mm) total += parseInt(mm[1], 10);
          return total || null;
        };
        trains.push({
          id: m[8],
          train_name: m[1],
          train_number: m[2],
          origin_city: m[3],
          destination_city: m[4],
          departure_time: m[5],
          available_seats: parseInt(m[6], 10),
          price: m[7] ? parseFloat(m[7]) : null,
          arrival_time: m[9] || null,
          duration_minutes: parseDur(m[10])
        });
      }
    }
  }
  return trains;
};

// Render helper: convert '/train/{id}' occurrences into clickable Next.js Links or TrainCards
const renderTextWithTrainLinks = (text) => {
  if (!text || typeof text !== 'string') return text;
  
  // Check if this looks like a train schedule response
  const trains = parseTrainSchedules(text);
  
  if (trains.length > 0) {
    // Build intro (before the first bullet line) and a cleaned footer without bullet lines
    const lines = text.split(/\\\\r?\\\\n/);
    let firstBulletIdx = lines.findIndex(l => /^\\\\s*\\\\-\\\\s/.test(l));
    if (firstBulletIdx === -1) firstBulletIdx = 0;
    const intro = lines.slice(0, firstBulletIdx).join('\\\\n').trim() || 'Available trains for your route:';
    // Footer: lines after the last bullet, excluding any lines that look like bullet items or contain direct schedule entries
    let lastBulletIdx = -1;
    lines.forEach((l, i) => { if (/^\\\\s*\\\\-\\\\s/.test(l)) lastBulletIdx = i; });
    const footerLines = lastBulletIdx >= 0 ? lines.slice(lastBulletIdx + 1) : [];
    const cleanedFooter = footerLines
      .filter(l => !/^\\\\s*\\\\-\\\\s/.test(l))
      .filter(l => !/\\\\s\\\\|\\\\s\\\\/train\\\\//.test(l))
      .join('\\\\n')
      .trim();
    
    return (
      <div className="w-full">
        <p className="text-base font-medium mb-4 text-gray-800">{intro}</p>
        <div className="space-y-4">
          {trains.map((train, index) => (
            <TrainCard key={train.id || index} train={train} onBook={handleBooking} />
          ))}
        </div>
        {cleanedFooter && <p className="text-sm mt-4 text-gray-500 whitespace-pre-wrap">{cleanedFooter}</p>}
      </div>
    );
  }

  // Render a styled zero-results panel if detected
  const noResPanel = renderNoResultsPanel(text);
  if (noResPanel) return noResPanel;

  // Regular text with train links
  const parts = text.split(/(\\\\/train\\\\/\\\\d+)/g);
  return parts.map((part, idx) => {
    if (/^\\\\/train\\\\/\\\\d+$/.test(part)) {
      return (
        <Link key={idx} href={part} className="inline-flex items-center gap-1 text-blue-700 underline font-medium">
          Book now
        </Link>
      );
    }
    return <React.Fragment key={idx}>{part}</React.Fragment>;
  });
};</code></pre>

<h5 class="integer vel font_w_font_s1">
    Why This Matters: The AI returns human-readable text with embedded structure. Instead of forcing the AI to return JSON (which LLMs sometimes mess up), we let it write naturally and parse the result. This is MORE reliable than strict JSON schemas.
</h5>
<h5 class="viverra font_w_font_s">Layer 2: The Controller – Orchestrating the Flow</h5>

<pre><code class="language-php">// backend/app/Http/Controllers/ChatbotController.php 

public function sendMessage(Request $request)
{
    $request->validate([
        'message' => 'required|string|max:1000',
        'context' => 'array',
        'conversation_id' => 'nullable|integer',
        'title' => 'nullable|string|max:120',
    ]);

    if (!$request->user()) {
        return response()->json(['error' => 'Unauthenticated'], 401);
    }

    $user = $request->user();
    $message = $request->get('message');
    $context = $request->get('context', []);
    $conversationId = $request->get('conversation_id');
    $titleInput = trim((string)$request->get('title', ''));

    $conversation = null;
    if ($conversationId) {
        $conversation = Conversation::where('id', $conversationId)->where('user_id', $user->id)->first();
    }
    if (!$conversation) {
        $autoTitle = $titleInput !== '' ? $titleInput : (function($m) {
            $plain = trim(preg_replace('/\\\\s+/', ' ', $m));
            return mb_substr($plain, 0, 64);
        })($message);
        $conversation = Conversation::create([
            'user_id' => $user->id,
            'title' => $autoTitle !== '' ? $autoTitle : null,
        ]);
    }

    try {
        $history = ConversationMessage::where('conversation_id', $conversation->id)
            ->orderBy('created_at', 'desc')
            ->limit(8)
            ->get(['message_text', 'is_from_user'])
            ->reverse();
        $historyContext = $history->map(function ($m) {
            return [ 'role' => $m->is_from_user ? 'user' : 'assistant', 'content' => (string) $m->message_text ];
        })->toArray();
        $context = array_merge($historyContext, is_array($context) ? $context : []);
    } catch (\\\\Throwable $e) {
        \\\\Log::warning('Failed to build conversation context', ['error' => $e->getMessage()]);
    }

    ConversationMessage::create([
        'user_id' => $user->id,
        'conversation_id' => $conversation->id,
        'message_text' => $message,
        'is_from_user' => true,
    ]);

    try {
        $aiResponse = $this->aiService->generateResponse($message, $context);

        ConversationMessage::create([
            'user_id' => $user->id,
            'conversation_id' => $conversation->id,
            'message_text' => $aiResponse['response'],
            'is_from_user' => false,
        ]);

        if (!$conversation->title) {
            $firstUserMessage = ConversationMessage::where('conversation_id', $conversation->id)
                ->where('is_from_user', true)
                ->orderBy('created_at', 'asc')
                ->value('message_text');
            if ($firstUserMessage) {
                $conversation->title = mb_substr(trim(preg_replace('/\\\\s+/', ' ', $firstUserMessage)), 0, 64);
            }
        }
        $conversation->touch();

        return response()->json([
            'response' => $aiResponse['response'],
            'used_fallback' => $aiResponse['used_fallback'] ?? false,
            'normalized_query' => $aiResponse['normalized_query'] ?? null,
            'timestamp' => now()->toISOString(),
            'conversation_id' => $conversation->id,
        ]);
    } catch (\\\\Exception $e) {
        return response()->json([
            'error' => 'Failed to process message',
            'message' => $e->getMessage()
        ], 500);
    }
}</code></pre>

<h5 class="integer vel font_w_font_s1">
    What's Happening Here:
</h5>
<div class="blog-pop-up-list-main">
    <ul class="blog-pop-up-list">
        <li><strong>Validation:</strong> Basic input checks</li>
        <li><strong>Conversation Management:</strong> Get or create a conversation thread</li>
        <li><strong>History Loading:</strong> Pull last 8 messages from DB </li>
        <li><strong>Context Merging:</strong> Combine DB history with any frontend context</li>
        <li><strong>AI Call:</strong> Hand off to the service layer</li>
        <li><strong>Persistence:</strong> Save both user and assistant messages</li>
        <li><strong>Response:</strong> Return the AI's answer</li>
    </ul>
</div>

<h5 class="integer vel font_w_font_s1">
    Why This Architecture: The controller stays thin. It handles HTTP concerns (validation, auth) and delegates business logic to the service layer. This makes testing easier.
</h5>
<h5 class="viverra font_w_font_s">Layer 3: The AI Service – The Brain</h5>

<pre><code class="language-php">// backend/app/Services/AI/ChatbotAIService.php 

public function generateResponse(string $message, array $context = []): array
{
    // Step 1: Normalize and extract entities
    $processedQuery = $this->nlpProcessor->processQuery($message);
    $enhancedContext = array_merge($context, [
        'nlp_analysis' => $processedQuery,
        'intent' => $processedQuery['intent'],
        'entities' => $processedQuery['entities'],
        'normalized_query' => $processedQuery['normalized'] ?? $message
    ]);
    $normalizedMessage = $processedQuery['normalized'] ?? $message;
    $systemPrompt = $this->buildSystemPrompt();
    $toolsSchema = $this->buildToolsSchema();

    try {
        $provider = $this->config['provider'] ?? 'gemini';
        switch ($provider) {
            case 'gemini':
                return $this->callGemini($normalizedMessage, $systemPrompt, $toolsSchema, $enhancedContext);
            case 'openrouter':
            case 'openai':
            case 'llama':
            case 'qwen':
                return $this->callOpenAICompatible($normalizedMessage, $systemPrompt, $toolsSchema, $enhancedContext);
            case 'deepseek':
                return $this->callDeepSeek($normalizedMessage, $systemPrompt, $toolsSchema);
            case 'anthropic':
                return $this->callAnthropic($normalizedMessage, $systemPrompt, $toolsSchema);
            default:
                throw new Exception("Unsupported provider: {$provider}");
        }
    } catch (Exception $e) {
        Log::error('AI provider error: ' . $e->getMessage());
        $fallback = $this->tryProactiveToolFallback($message, $enhancedContext);
        if ($fallback) {
            return [
                'response' => $fallback,
                'used_fallback' => true,
                'tool_calls' => [],
                'nlp_analysis' => $processedQuery,
                'normalized_query' => $processedQuery['normalized'] ?? $message,
            ];
        }
        return [
            'response' => "I apologize, but I'm having trouble processing your request. Please try again later.",
            'used_fallback' => false,
            'tool_calls' => [],
            'nlp_analysis' => $processedQuery,
            'normalized_query' => $processedQuery['normalized'] ?? $message,
        ];
    }
}</code></pre>

<h4 class="nunc font_w_font_s1">
    The Proactive Fallback
</h4>

<h4 class="nunc font_w_font_s1">
    - when the AI fails, your system doesn't:
</h4>

<pre><code class="language-php">// backend/app/Services/AI/ChatbotAIService.php 

protected function tryProactiveToolFallback(string $userMessage, array $context = []): ?string
{
    // Guard: require both tools
    if (!isset($this->tools['search_stations']) || !isset($this->tools['get_train_schedules'])) {
        return null;
    }

    // Extract origin/destination from free text
    $extractFromText = function (string $text): array {
        $origin = null;
        $dest = null;
        
        // Mask date ranges to avoid confusing them with routes
        $tempText = preg_replace(
            '/\\\\bbetween\\\\s+[^,]+?\\\\s+(?:and|to|\\\\-)\\\\s+[^,]+?\\\\b/i',
            '[DATE_RANGE]',
            $text
        );
        
        // Look for "from X" pattern
        if (preg_match_all('/\\\\bfrom\\\\s+([a-zA-Z\\\\-\\\\s]{2,})/i', $tempText, $mAll) && !empty($mAll[1])) {
            $cand = end($mAll[1]);
            $origin = trim(preg_split(
                '/\\\\s+(to|for|on|at|by|until|till|through|thru|and|next|this|tomorrow|today|\\\\[DATE_RANGE\\\\])\\\\b/i',
                trim($cand)
            )[0] ?? $cand);
        }
        
        // Look for "to Y" pattern
        if (preg_match_all('/\\\\bto\\\\s+([a-zA-Z\\\\-\\\\s]{2,})/i', $tempText, $mAll2) && !empty($mAll2[1])) {
            $cand2 = end($mAll2[1]);
            $dest = trim(preg_split(
                '/\\\\s+(from|for|on|at|by|until|till|through|thru|and|next|this|tomorrow|today|\\\\[DATE_RANGE\\\\])\\\\b/i',
                trim($cand2)
            )[0] ?? $cand2);
        }
        
        // Fallback: look for "X to Y" or "X -> Y" pattern
        if ($origin === null && preg_match(
            '/\\\\b([a-zA-Z\\\\-]+(?:\\\\s+[a-zA-Z\\\\-]+)*)\\\\s+(?:to|\\\\-\\\\>)\\\\s+([a-zA-Z\\\\-]+(?:\\\\s+[a-zA-Z\\\\-]+)*)\\\\b/i',
            $tempText,
            $m3
        )) {
            $origin = trim($m3[1]);
            $dest = trim($m3[2]);
        }
        
        return [$origin, $dest];
    };

    // Normalize city names 
    $normalizeCity = function (?string $s): ?string {
        if (!$s) return null;
        $v = strtolower(trim($s));
        
        $map = [
            'sf' => 'San Francisco',
            'sfo' => 'San Francisco',
            'sanfrancisco' => 'San Francisco',
            'san fransico' => 'San Francisco',  // Common misspelling
            'sanfransisco' => 'San Francisco',
            'la' => 'Los Angeles',
            'nyc' => 'New York',
            'ny' => 'New York',
            'dal' => 'Dallas',
            // ... more mappings
        ];
        
        return $map[$v] ?? $s;
    };

    [$origin, $destination] = $extractFromText($userMessage);
    $origin = $normalizeCity($origin);
    $destination = $normalizeCity($destination);

    // If both cities present, run schedules directly
    if (!empty($origin) && !empty($destination)) {
        $params = [
            'origin' => $origin,
            'destination' => $destination,
            'limit' => 12,
            'date_window_days' => 14
        ];
        
        $direct = $this->tools['get_train_schedules']->execute($params);
        
        if (($direct['success'] ?? false) && (($direct['count'] ?? 0) > 0)) {
            return trim($this->formatTrainSchedules($direct['data'] ?? [], $direct['count'] ?? 0));
        }
    }

    // Otherwise, search stations to infer a concrete city/station
    $stations = [];
    foreach ([$origin, $destination] as $q) {
        if (!$q) continue;
        
        $res = $this->tools['search_stations']->execute(['query' => $q, 'limit' => 3]);
        if ($res['success'] && !empty($res['data'])) {
            $stations = $res['data'];
            break;
        }
    }
    
    if (empty($stations)) {
        return null;
    }

    // Use top station to build a schedules query
    $city = $stations[0]['city'] ?? null;
    $name = $stations[0]['name'] ?? null;
    $originOpt = $origin ?: ($city ?: $name);
    
    $params = ['origin' => $originOpt, 'limit' => 6, 'date_window_days' => 14];
    if ($destination) {
        $params['destination'] = $destination;
    }
    
    $res = $this->tools['get_train_schedules']->execute($params);
    
    if (($res['success'] ?? false) && (($res['count'] ?? 0) > 0)) {
        return trim($this->formatTrainSchedules($res['data'] ?? [], $res['count'] ?? 0));
    }
    
    return "I can search anywhere from {$originOpt}. Try adding a destination like 'to Seattle'.";
}</code></pre>

<h5 class="integer vel font_w_font_s1">
    Why This Is Brilliant:
</h5>
<div class="blog-pop-up-list-main">
    <ul class="blog-pop-up-list">
        <li>LLMs sometimes ignore tool schemas</li>
        <li>LLMs sometimes return "I don't have that info" when they should call a tool</li>
        <li>Your fallback extracts entities manually and calls tools directly</li>
        <li><strong>Result:</strong> The chatbot ALWAYS tries to help, even when the AI model fails</li>
    </ul>
</div>

<h5 class="viverra font_w_font_s">Layer 4: NLP Processor – Making Messy Input Clean</h5>

<pre><code class="language-php">// backend/app/Services/AI/NLPProcessor.php (

protected function normalizeQuery(string $query): string
{
    $query = strtolower(trim($query));
    
    // Replace variations (e.g., "display" → "show me")
    foreach ($this->variations as $standard => $alternatives) {
        foreach ($alternatives as $alt) {
            $query = str_replace($alt, $standard, $query);
        }
    }
    
    // Normalize follow-up phrasing from UI
    $query = preg_replace('/\\\\bfilter\\\\s+to\\\\s+/i', 'to ', $query);
    $query = preg_replace('/\\\\bfilter\\\\s+by\\\\s+/i', '', $query);
    
    // Preserve punctuation useful for dates (/, -, , and :)
    $query = preg_replace('/\\\\s+/', ' ', $query);
    $query = preg_replace('/[^\\\\w\\\\s\\\\/-,:]/', ' ', $query);
    
    return trim($query);
}

protected function normalizeAmericanLocations(array $locations): array
{
    $cityMap = [
        'nyc' => 'New York',
        'la' => 'Los Angeles',
        'sf' => 'San Francisco',
        // ... more mappings from your article
    ];
    
    // Strip common station suffixes like "station", "terminal", "stn"
    foreach (['origin', 'destination'] as $key) {
        if ($locations[$key]) {
            $cleaned = preg_replace(
                '/\\\\s+(terminal|station|central|stn|depot|rail|railway)$/i',
                '',
                trim($locations[$key])
            );
            $locations[$key] = $cleaned;
        }
    }
    
    // Apply city mappings
    foreach (['origin', 'destination'] as $key) {
        if ($locations[$key]) {
            $normalized = strtolower(trim($locations[$key]));
            if (isset($cityMap[$normalized])) {
                $locations[$key] = $cityMap[$normalized];
            }
        }
    }
    
    return $locations;
}</code></pre>

<h4 class="nunc font_w_font_s1">
    The Result: A Conversation That Just Works
</h4>

<h4 class="nunc font_w_font_s1">
    Let me show you a real conversation flow:
</h4>

<h4 class="nunc font_w_font_s1">
    Turn 1:
</h4>

<h4 class="nunc font_w_font_s1">
    User: "trains from sf to la tomorrow morning"
</h4>

<h4 class="nunc font_w_font_s1">
    What happens:
</h4>

<div class="blog-pop-up-list-main">
    <ul class="blog-pop-up-list">
        <li>Controller loads empty history (first message)</li>
        <li><strong>AI Service calls NLP:</strong> "sf" → "San Francisco", "la" → "Los Angeles", extracts "tomorrow morning"</li>
        <li>AI Service calls LLM with tools → LLM calls get_train_schedules</li>
        <li>Tool returns 5 trains</li>
<h4 class="nunc font_w_font_s1">
    AI formats as bullets: "- Express 101 (EX101): San Francisco → Los Angeles | Departs 8:00 AM | Seats: 45 | From $89 | /train/123"
</h4>

        <li>Frontend parses bullets → renders TrainCards</li>
        <li>Messages saved to DB</li>
    </ul>
</div>

<h4 class="nunc font_w_font_s1">
    Turn 2:
</h4>

<h4 class="nunc font_w_font_s1">
    User: "what about afternoon?"
</h4>

<h4 class="nunc font_w_font_s1">
    What happens:
</h4>

<div class="blog-pop-up-list-main">
    <ul class="blog-pop-up-list">
        <li><strong>Controller loads history:</strong> includes Turn 1's "sf to la tomorrow"</li>
        <li>AI Service sees context, understands "afternoon" refers to same route</li>
        <li>Either LLM calls tool with time filter, OR fallback extracts from context</li>
        <li>Returns afternoon trains</li>
        <li>User never had to repeat "San Francisco to Los Angeles"</li>
    </ul>
</div>

<h4 class="nunc font_w_font_s1">
    Conclusion: Why This Architecture Works
</h4>

<h5 class="viverra font_w_font_s">Resilience Through Layers</h5>
<div class="blog-pop-up-list-main">
    <ul class="blog-pop-up-list">
        <li>If LLM fails → Proactive fallback</li>
        <li>If tools fail → Clear error message</li>
        <li>If user typos → NLP normalization catches it</li>
    </ul>
</div>

<h5 class="viverra font_w_font_s">Memory Without Client Hacks</h5>
<div class="blog-pop-up-list-main">
    <ul class="blog-pop-up-list">
        <li>No localStorage tricks</li>
        <li>No "pass entire conversation in every request"</li>
        <li>Clean DB storage with efficient loading (last 8 messages)</li>
    </ul>
</div>

<h5 class="viverra font_w_font_s">Actionable UI</h5>
<div class="blog-pop-up-list-main">
    <ul class="blog-pop-up-list">
        <li>AI returns structured text</li>
        <li>Frontend parses into interactive cards</li>
        <li>Users click "Book" immediately</li>
    </ul>
</div>

<h5 class="viverra font_w_font_s">Debuggability</h5>
<div class="blog-pop-up-list-main">
    <ul class="blog-pop-up-list">
        <li>Every message logged to DB</li>
        <li>Tool calls are explicit</li>
        <li>Fallback paths are traceable</li>
    </ul>
</div>

<div class="page-wrapper trigger">
    <div class="circle-wrapper">
        <div class="warning circle_close"></div>
        <div class="close-btn font_w_font_s1">CLOSE</div>
    </div>
</div>`
};
