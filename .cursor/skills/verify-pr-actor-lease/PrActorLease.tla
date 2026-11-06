---------------------------- MODULE PrActorLease ----------------------------
EXTENDS Integers, FiniteSets

CONSTANTS FenceOn, AllowExpire

Workers == {"w1", "w2", "r1"}
Items == {"i1", "i2"}
MaxEpoch == 3

ItemOf(w) ==
  CASE w = "w1" -> "i1"
    [] w = "w2" -> "i2"
    [] w = "r1" -> "i1"

VARIABLES
  leaseEpoch, leaseItem, leaseExpired,
  phase, heldEpoch, signalAborted,
  intentMutating, sends,
  durableEpoch, durableItem, staleDurable,
  itemTerminal

vars == <<leaseEpoch, leaseItem, leaseExpired,
          phase, heldEpoch, signalAborted,
          intentMutating, sends,
          durableEpoch, durableItem, staleDurable,
          itemTerminal>>

TypeOk ==
  /\ leaseEpoch \in 0..MaxEpoch
  /\ leaseItem \in Items \cup {"none"}
  /\ leaseExpired \in BOOLEAN
  /\ phase \in [Workers -> {"idle", "held", "mutating", "armed", "sent", "done"}]
  /\ heldEpoch \in [Workers -> 0..MaxEpoch]
  /\ signalAborted \in [Workers -> BOOLEAN]
  /\ intentMutating \in [Items -> BOOLEAN]
  /\ sends \in [Items -> 0..3]
  /\ durableEpoch \in 0..MaxEpoch
  /\ durableItem \in Items \cup {"none"}
  /\ staleDurable \in BOOLEAN
  /\ itemTerminal \in [Items -> BOOLEAN]

\* renewPrActorLease matches epoch and work item. It does not read expires_at.
RowOwner(w) ==
  /\ heldEpoch[w] > 0
  /\ leaseEpoch = heldEpoch[w]
  /\ leaseItem = ItemOf(w)

\* isPrActorLeaseHeld. An expired row is not held.
Held(w) ==
  /\ RowOwner(w)
  /\ ~leaseExpired

\* One pending __mutating intent for the resource. Operation key is not part of it.
ResourceMutating == \E i \in Items : intentMutating[i]

LeaseFree == leaseItem = "none" \/ leaseExpired

Init ==
  /\ leaseEpoch = 0
  /\ leaseItem = "none"
  /\ leaseExpired = TRUE
  /\ phase = [w \in Workers |-> "idle"]
  /\ heldEpoch = [w \in Workers |-> 0]
  /\ signalAborted = [w \in Workers |-> FALSE]
  /\ intentMutating = [i \in Items |-> FALSE]
  /\ sends = [i \in Items |-> 0]
  /\ durableEpoch = 0
  /\ durableItem = "none"
  /\ staleDurable = FALSE
  /\ itemTerminal = [i \in Items |-> FALSE]

\* acquirePrActorLease. One INSERT ... ON CONFLICT DO UPDATE.
Acquire(w) ==
  /\ phase[w] = "idle"
  /\ LeaseFree
  /\ leaseEpoch < MaxEpoch
  /\ leaseEpoch' = leaseEpoch + 1
  /\ leaseItem' = ItemOf(w)
  /\ leaseExpired' = FALSE
  /\ phase' = [phase EXCEPT ![w] = "held"]
  /\ heldEpoch' = [heldEpoch EXCEPT ![w] = leaseEpoch + 1]
  /\ UNCHANGED <<signalAborted, intentMutating, sends, durableEpoch, durableItem, staleDurable, itemTerminal>>

\* TTL elapsed. The renewal bit is the model's expires_at.
Expire ==
  /\ AllowExpire
  /\ leaseItem /= "none"
  /\ ~leaseExpired
  /\ leaseExpired' = TRUE
  /\ UNCHANGED <<leaseEpoch, leaseItem, phase, heldEpoch, signalAborted,
                 intentMutating, sends, durableEpoch, durableItem, staleDurable, itemTerminal>>

\* renewPrActorLease. Matches epoch and work_item_id. Does not read expires_at.
Renew(w) ==
  /\ phase[w] \in {"held", "mutating", "armed", "sent"}
  /\ RowOwner(w)
  /\ leaseExpired
  /\ leaseExpired' = FALSE
  /\ UNCHANGED <<leaseEpoch, leaseItem, phase, heldEpoch, signalAborted,
                 intentMutating, sends, durableEpoch, durableItem, staleDurable, itemTerminal>>

\* releasePrActorLeaseHeldByWorkItems. Clears the holder. Does not bump lease_epoch.
CancelClear ==
  /\ leaseItem /= "none"
  /\ leaseItem' = "none"
  /\ leaseExpired' = TRUE
  /\ UNCHANGED <<leaseEpoch, phase, heldEpoch, signalAborted,
                 intentMutating, sends, durableEpoch, durableItem, staleDurable, itemTerminal>>

\* startCancelObserve or a failed renew. A later poll, not the SQL clear itself.
ObserveLoss(w) ==
  /\ ~signalAborted[w]
  /\ phase[w] \in {"held", "mutating", "armed", "sent"}
  /\ ~Held(w)
  /\ signalAborted' = [signalAborted EXCEPT ![w] = TRUE]
  /\ UNCHANGED <<leaseEpoch, leaseItem, leaseExpired, phase, heldEpoch,
                 intentMutating, sends, durableEpoch, durableItem, staleDurable, itemTerminal>>

\* mergeOperationIntentDetail writes __mutating before the GitHub call.
\* The EXISTS check reads expires_at. A second worker recovers the resource intent.
MarkMutating(w) ==
  /\ phase[w] = "held"
  /\ Held(w)
  /\ ~ResourceMutating
  /\ intentMutating' = [intentMutating EXCEPT ![ItemOf(w)] = TRUE]
  /\ phase' = [phase EXCEPT ![w] = "mutating"]
  /\ UNCHANGED <<leaseEpoch, leaseItem, leaseExpired, heldEpoch, signalAborted,
                 sends, durableEpoch, durableItem, staleDurable, itemTerminal>>

\* publishOnceBody recovers a pending __mutating intent on this resource.
\* The other work item recovers even when its operation key differs.
RecoverInFlight(w) ==
  /\ phase[w] = "held"
  /\ Held(w)
  /\ ResourceMutating
  /\ phase' = [phase EXCEPT ![w] = "done"]
  /\ UNCHANGED <<leaseEpoch, leaseItem, leaseExpired, heldEpoch, signalAborted,
                 intentMutating, sends, durableEpoch, durableItem, staleDurable, itemTerminal>>

DropBeforeMutating(w) ==
  /\ phase[w] = "held"
  /\ ~Held(w)
  /\ phase' = [phase EXCEPT ![w] = "done"]
  /\ UNCHANGED <<leaseEpoch, leaseItem, leaseExpired, heldEpoch, signalAborted,
                 intentMutating, sends, durableEpoch, durableItem, staleDurable, itemTerminal>>

\* assertPrActorLeaseHeld in createLeaseMutationBoundary, immediately before mutate.
\* A lost lease before the GitHub call releases this item's unsent __mutating flag.
Arm(w) ==
  /\ phase[w] = "mutating"
  /\ IF Held(w)
     THEN /\ phase' = [phase EXCEPT ![w] = "armed"]
          /\ UNCHANGED intentMutating
     ELSE /\ phase' = [phase EXCEPT ![w] = "done"]
          /\ intentMutating' = [intentMutating EXCEPT ![ItemOf(w)] = FALSE]
  /\ UNCHANGED <<leaseEpoch, leaseItem, leaseExpired, heldEpoch, signalAborted,
                 sends, durableEpoch, durableItem, staleDurable, itemTerminal>>

\* withPrSurfaceMutationBoundary. throwIfAborted, then the lease read, then the GitHub call.
\* ~Held here is the pre-send lease read. It releases the unsent __mutating flag.
\* A still-held abort does not, because that gate is not a lost lease.
AbortGate(w) ==
  /\ phase[w] = "armed"
  /\ IF ~Held(w)
     THEN /\ phase' = [phase EXCEPT ![w] = "done"]
          /\ intentMutating' = [intentMutating EXCEPT ![ItemOf(w)] = FALSE]
          /\ UNCHANGED sends
     ELSE IF signalAborted[w]
          THEN /\ phase' = [phase EXCEPT ![w] = "done"]
               /\ UNCHANGED <<intentMutating, sends>>
          ELSE /\ sends[ItemOf(w)] < 3
               /\ phase' = [phase EXCEPT ![w] = "sent"]
               /\ sends' = [sends EXCEPT ![ItemOf(w)] = sends[ItemOf(w)] + 1]
               /\ UNCHANGED intentMutating
  /\ UNCHANGED <<leaseEpoch, leaseItem, leaseExpired, heldEpoch, signalAborted,
                 durableEpoch, durableItem, staleDurable, itemTerminal>>

\* reconcileOperationIntent and recordPublishStep. The EXISTS lease predicate is FenceOn.
Reconcile(w) ==
  /\ phase[w] = "sent"
  /\ phase' = [phase EXCEPT ![w] = "done"]
  /\ IF FenceOn /\ Held(w)
     THEN /\ durableEpoch' = heldEpoch[w]
          /\ durableItem' = ItemOf(w)
          /\ staleDurable' = staleDurable
     ELSE IF ~FenceOn
          THEN /\ durableEpoch' = heldEpoch[w]
               /\ durableItem' = ItemOf(w)
               /\ staleDurable' = (staleDurable \/ ~Held(w))
          ELSE /\ durableEpoch' = durableEpoch
               /\ durableItem' = durableItem
               /\ staleDurable' = staleDurable
  /\ UNCHANGED <<leaseEpoch, leaseItem, leaseExpired, heldEpoch, signalAborted,
                 intentMutating, sends, itemTerminal>>

\* releasePrActorLease. Matches lease_epoch only. A stale epoch updates zero rows.
Release(w) ==
  /\ phase[w] = "done"
  /\ heldEpoch[w] = leaseEpoch
  /\ leaseItem = ItemOf(w)
  /\ leaseItem' = "none"
  /\ leaseExpired' = TRUE
  /\ UNCHANGED <<leaseEpoch, phase, heldEpoch, signalAborted,
                 intentMutating, sends, durableEpoch, durableItem, staleDurable, itemTerminal>>

\* A review work item has reached a terminal status.
MarkTerminal(w) ==
  /\ ~itemTerminal[ItemOf(w)]
  /\ itemTerminal' = [itemTerminal EXCEPT ![ItemOf(w)] = TRUE]
  /\ UNCHANGED <<leaseEpoch, leaseItem, leaseExpired, phase, heldEpoch, signalAborted,
                 intentMutating, sends, durableEpoch, durableItem, staleDurable>>

\* closeReviewVerdict when leaseEpoch is null. The item is terminal and no
\* worker is Held or still on the leased send path. One shared lease means
\* any worker in held, mutating, or armed can still send.
\* It is the one send when that path did not send.
TerminalClose(w) ==
  /\ itemTerminal[ItemOf(w)]
  /\ \A holder \in Workers : ~Held(holder)
  /\ \A holder \in Workers : phase[holder] \notin {"held", "mutating", "armed"}
  /\ sends["i1"] + sends["i2"] = 0
  /\ intentMutating' = [intentMutating EXCEPT ![ItemOf(w)] = TRUE]
  /\ sends' = [sends EXCEPT ![ItemOf(w)] = 1]
  /\ UNCHANGED <<leaseEpoch, leaseItem, leaseExpired, phase, heldEpoch, signalAborted,
                 durableEpoch, durableItem, staleDurable, itemTerminal>>

Pause == UNCHANGED vars

Next ==
  \/ \E w \in Workers : Acquire(w)
  \/ Expire
  \/ \E w \in Workers : Renew(w)
  \/ CancelClear
  \/ \E w \in Workers : ObserveLoss(w)
  \/ \E w \in Workers : MarkMutating(w)
  \/ \E w \in Workers : RecoverInFlight(w)
  \/ \E w \in Workers : DropBeforeMutating(w)
  \/ \E w \in Workers : Arm(w)
  \/ \E w \in Workers : AbortGate(w)
  \/ \E w \in Workers : Reconcile(w)
  \/ \E w \in Workers : Release(w)
  \/ \E w \in Workers : MarkTerminal(w)
  \/ \E w \in Workers : TerminalClose(w)
  \/ Pause

Spec == Init /\ [][Next]_vars

OneHolder ==
  Cardinality({w \in Workers : Held(w)}) <= 1

AtMostOneSendPerWorkItem ==
  \A i \in Items : sends[i] <= 1

AtMostOneGithubSend ==
  sends["i1"] + sends["i2"] <= 1

SendImpliesIntent ==
  \A i \in Items : sends[i] > 0 => intentMutating[i]

NoStaleDurable ==
  ~staleDurable

MonotonicEpoch ==
  [][leaseEpoch' >= leaseEpoch]_vars

=============================================================================
