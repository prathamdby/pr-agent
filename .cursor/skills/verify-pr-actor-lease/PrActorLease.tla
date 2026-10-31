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
  durableEpoch, durableItem, staleDurable

vars == <<leaseEpoch, leaseItem, leaseExpired,
          phase, heldEpoch, signalAborted,
          intentMutating, sends,
          durableEpoch, durableItem, staleDurable>>

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
  /\ UNCHANGED <<signalAborted, intentMutating, sends, durableEpoch, durableItem, staleDurable>>

\* TTL elapsed. The renewal bit is the model's expires_at.
Expire ==
  /\ AllowExpire
  /\ leaseItem /= "none"
  /\ ~leaseExpired
  /\ leaseExpired' = TRUE
  /\ UNCHANGED <<leaseEpoch, leaseItem, phase, heldEpoch, signalAborted,
                 intentMutating, sends, durableEpoch, durableItem, staleDurable>>

\* renewPrActorLease. Matches epoch and work_item_id. Does not read expires_at.
Renew(w) ==
  /\ phase[w] \in {"held", "mutating", "armed", "sent"}
  /\ RowOwner(w)
  /\ leaseExpired
  /\ leaseExpired' = FALSE
  /\ UNCHANGED <<leaseEpoch, leaseItem, phase, heldEpoch, signalAborted,
                 intentMutating, sends, durableEpoch, durableItem, staleDurable>>

\* releasePrActorLeaseHeldByWorkItems. Clears the holder. Does not bump lease_epoch.
CancelClear ==
  /\ leaseItem /= "none"
  /\ leaseItem' = "none"
  /\ leaseExpired' = TRUE
  /\ UNCHANGED <<leaseEpoch, phase, heldEpoch, signalAborted,
                 intentMutating, sends, durableEpoch, durableItem, staleDurable>>

\* startCancelObserve or a failed renew. A later poll, not the SQL clear itself.
ObserveLoss(w) ==
  /\ ~signalAborted[w]
  /\ phase[w] \in {"held", "mutating", "armed", "sent"}
  /\ ~Held(w)
  /\ signalAborted' = [signalAborted EXCEPT ![w] = TRUE]
  /\ UNCHANGED <<leaseEpoch, leaseItem, leaseExpired, phase, heldEpoch,
                 intentMutating, sends, durableEpoch, durableItem, staleDurable>>

\* mergeOperationIntentDetail writes __mutating before the GitHub call.
\* The EXISTS check reads expires_at. A second worker recovers the resource intent.
MarkMutating(w) ==
  /\ phase[w] = "held"
  /\ Held(w)
  /\ ~ResourceMutating
  /\ intentMutating' = [intentMutating EXCEPT ![ItemOf(w)] = TRUE]
  /\ phase' = [phase EXCEPT ![w] = "mutating"]
  /\ UNCHANGED <<leaseEpoch, leaseItem, leaseExpired, heldEpoch, signalAborted,
                 sends, durableEpoch, durableItem, staleDurable>>

\* publishOnceBody recovers a pending __mutating intent on this resource.
\* The other work item recovers even when its operation key differs.
RecoverInFlight(w) ==
  /\ phase[w] = "held"
  /\ Held(w)
  /\ ResourceMutating
  /\ phase' = [phase EXCEPT ![w] = "done"]
  /\ UNCHANGED <<leaseEpoch, leaseItem, leaseExpired, heldEpoch, signalAborted,
                 intentMutating, sends, durableEpoch, durableItem, staleDurable>>

DropBeforeMutating(w) ==
  /\ phase[w] = "held"
  /\ ~Held(w)
  /\ phase' = [phase EXCEPT ![w] = "done"]
  /\ UNCHANGED <<leaseEpoch, leaseItem, leaseExpired, heldEpoch, signalAborted,
                 intentMutating, sends, durableEpoch, durableItem, staleDurable>>

\* assertPrActorLeaseHeld in createLeaseMutationBoundary, immediately before mutate.
Arm(w) ==
  /\ phase[w] = "mutating"
  /\ \/ /\ Held(w)
        /\ phase' = [phase EXCEPT ![w] = "armed"]
     \/ /\ ~Held(w)
        /\ phase' = [phase EXCEPT ![w] = "done"]
  /\ UNCHANGED <<leaseEpoch, leaseItem, leaseExpired, heldEpoch, signalAborted,
                 intentMutating, sends, durableEpoch, durableItem, staleDurable>>

\* withPrSurfaceMutationBoundary. throwIfAborted, then the lease read, then the GitHub call.
AbortGate(w) ==
  /\ phase[w] = "armed"
  /\ \/ /\ signalAborted[w]
        /\ phase' = [phase EXCEPT ![w] = "done"]
        /\ UNCHANGED sends
     \/ /\ ~signalAborted[w]
        /\ ~Held(w)
        /\ phase' = [phase EXCEPT ![w] = "done"]
        /\ UNCHANGED sends
     \/ /\ ~signalAborted[w]
        /\ Held(w)
        /\ sends[ItemOf(w)] < 3
        /\ phase' = [phase EXCEPT ![w] = "sent"]
        /\ sends' = [sends EXCEPT ![ItemOf(w)] = sends[ItemOf(w)] + 1]
  /\ UNCHANGED <<leaseEpoch, leaseItem, leaseExpired, heldEpoch, signalAborted,
                 intentMutating, durableEpoch, durableItem, staleDurable>>

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
                 intentMutating, sends>>

\* releasePrActorLease. Matches lease_epoch only. A stale epoch updates zero rows.
Release(w) ==
  /\ phase[w] = "done"
  /\ heldEpoch[w] = leaseEpoch
  /\ leaseItem = ItemOf(w)
  /\ leaseItem' = "none"
  /\ leaseExpired' = TRUE
  /\ UNCHANGED <<leaseEpoch, phase, heldEpoch, signalAborted,
                 intentMutating, sends, durableEpoch, durableItem, staleDurable>>

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
