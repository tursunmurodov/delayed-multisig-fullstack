// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract DelayedExecutionMultiSig {
    uint256 private _status;
    modifier nonReentrant() {
        require(_status != 2, "reentrant");
        _status = 2;
        _;
        _status = 1;
    }

    modifier whenNotPaused() {
        require(!paused, "paused");
        _;
    }

    // Ownership + core params
    mapping(address => bool) public isOwner;
    address[] public ownerList;
    uint256 public threshold;
    uint256 public minDelayGlobal;
    address public guardian;

    bool public paused;
    uint256 public proposalExpiryDuration = 600; // 10 minutes

    enum ProposalKind { Transaction, Governance }

    struct Proposal {
        address proposer;
        ProposalKind kind;
        address to;
        uint256 value;
        bytes data;
        uint256 eta;
        bool executed;
        bool cancelled;
        uint256 approvals;
    }

    mapping(bytes32 => Proposal) private _proposals;
    mapping(bytes32 => mapping(address => bool)) private _approvedBy;

    // Events
    event ProposalCreated(bytes32 indexed id, address indexed proposer, address indexed to, uint256 value, uint256 eta);
    event GovernanceProposalCreated(bytes32 indexed id, address indexed proposer, uint8 kind, uint256 eta);
    event ProposalApproved(bytes32 indexed id, address indexed signer);
    event ProposalRevoked(bytes32 indexed id, address indexed signer);
    event ProposalCancelled(bytes32 indexed id, address indexed canceller, string reason);
    event ProposalExecuted(bytes32 indexed id, address indexed executor, bool success, bytes ret);

    event OwnerAdded(address indexed owner);
    event OwnerRemoved(address indexed owner);
    event ThresholdChanged(uint256 newThreshold);
    event MinDelayChanged(uint256 newMinDelay);
    event GuardianChanged(address newGuardian);

    event Paused();
    event Resumed();

    modifier onlyOwner() {
        require(isOwner[msg.sender], "not owner");
        _;
    }

    modifier onlyGuardian() {
        require(msg.sender == guardian, "not guardian");
        _;
    }

    constructor(address[] memory _owners, uint256 _threshold, uint256 _minDelay, address _guardian) {
        require(_owners.length > 0, "owners");
        for (uint i = 0; i < _owners.length; i++) {
            address o = _owners[i];
            require(o != address(0), "zero owner");
            require(!isOwner[o], "dup owner");
            isOwner[o] = true;
            ownerList.push(o);
            emit OwnerAdded(o);
        }
        require(_threshold > 0 && _threshold <= _owners.length, "bad threshold");

        threshold = _threshold;
        minDelayGlobal = _minDelay;
        guardian = _guardian;

        _status = 1;

        emit ThresholdChanged(_threshold);
        emit MinDelayChanged(_minDelay);
        emit GuardianChanged(_guardian);
    }

    // ------------------
    // PROPOSALS
    // ------------------

    /**
     * @notice Creates a new transaction proposal.
     * @dev Generates a unique ID based on parameters, nonce (block.number), and sender.
     * @param to The target address for the transaction.
     * @param value The amount of ETH to send.
     * @param data The calldata to execute.
     * @param delay The delay in seconds (must be >= global minDelay).
     * @return id The generated proposal ID.
     */
    function proposeTransaction(address to, uint256 value, bytes calldata data, uint256 delay)
        external
        onlyOwner
        whenNotPaused
        returns (bytes32 id)
    {
        require(delay >= minDelayGlobal, "delay<min");
        uint256 eta = block.timestamp + delay;
        id = keccak256(abi.encode(msg.sender, to, value, data, eta, block.number));
        require(_proposals[id].proposer == address(0), "exists");

        _proposals[id] = Proposal({
            proposer: msg.sender,
            kind: ProposalKind.Transaction,
            to: to,
            value: value,
            data: data,
            eta: eta,
            executed: false,
            cancelled: false,
            approvals: 0
        });

        emit ProposalCreated(id, msg.sender, to, value, eta);
    }

    function proposeGovernance(bytes calldata encoded, uint256 delay)
        external
        onlyOwner
        whenNotPaused
        returns (bytes32 id)
    {
        require(delay >= minDelayGlobal, "delay<min");
        require(encoded.length >= 1, "bad enc");

        uint256 eta = block.timestamp + delay;
        id = keccak256(abi.encode(msg.sender, bytes1(encoded[0]), encoded[1:], eta, block.number));
        require(_proposals[id].proposer == address(0), "exists");

        _proposals[id] = Proposal({
            proposer: msg.sender,
            kind: ProposalKind.Governance,
            to: address(0),
            value: 0,
            data: encoded,
            eta: eta,
            executed: false,
            cancelled: false,
            approvals: 0
        });

        emit GovernanceProposalCreated(id, msg.sender, uint8(encoded[0]), eta);
    }

    /**
     * @notice Approves a pending proposal.
     * @dev Increases approval count. If count >= threshold, the proposal effectively becomes queued.
     * @param id The proposal ID to approve.
     */
    function approve(bytes32 id)
        external
        onlyOwner
        whenNotPaused
    {
        Proposal storage p = _proposals[id];
        require(p.proposer != address(0), "no id");
        require(!p.executed && !p.cancelled, "finalized");
        require(!_approvedBy[id][msg.sender], "dup");

        _approvedBy[id][msg.sender] = true;
        p.approvals += 1;

        emit ProposalApproved(id, msg.sender);
    }

    /**
     * @notice Revokes a previous approval.
     * @dev Can only be done before execution.
     * @param id The proposal ID to revoke.
     */
    function revoke(bytes32 id)
        external
        onlyOwner
        whenNotPaused
    {
        Proposal storage p = _proposals[id];
        require(p.proposer != address(0), "no id");
        require(!p.executed && !p.cancelled, "finalized");
        require(block.timestamp < p.eta, "past ETA");
        require(_approvedBy[id][msg.sender], "no appr");

        _approvedBy[id][msg.sender] = false;
        p.approvals -= 1;

        emit ProposalRevoked(id, msg.sender);
    }

    // Cancel is allowed always for guardian even while paused
    /**
     * @notice Cancels a proposal.
     * @dev Callable by Guardian or Owners. Guardian can cancel even when paused to stop attacks.
     * @param id The proposal ID.
     * @param reason The reason for cancellation (emitted in event).
     */
    function cancel(bytes32 id, string calldata reason)
        external
    {
        Proposal storage p = _proposals[id];
        require(p.proposer != address(0), "no id");
        require(!p.executed && !p.cancelled, "finalized");
        require(block.timestamp < p.eta, "past ETA");
        require(isOwner[msg.sender] || msg.sender == guardian, "no right");

        p.cancelled = true;
        emit ProposalCancelled(id, msg.sender, reason);
    }

    /**
     * @notice Executes a ready proposal.
     * @dev Checks: 1) Quorum met. 2) ETA passed. 3) Not expired. 4) Not cancelled/executed.
     * @param id The proposal ID to execute.
     */
    function execute(bytes32 id)
        external
        payable
        nonReentrant
        whenNotPaused
    {
        Proposal storage p = _proposals[id];
        require(p.proposer != address(0), "no id");
        require(!p.executed && !p.cancelled, "finalized");
        require(p.approvals >= threshold, "need quorum");
        require(block.timestamp >= p.eta, "before ETA");
        require(block.timestamp <= p.eta + proposalExpiryDuration, "expired");

        p.executed = true;

        bool ok; bytes memory ret;
        if (p.kind == ProposalKind.Transaction) {
            (ok, ret) = p.to.call{value: p.value}(p.data);
        } else {
            (ok, ret) = _executeGovernance(p.data);
        }

        emit ProposalExecuted(id, msg.sender, ok, ret);
        require(ok, "exec failed");
    }

    // ------------------
    // PAUSE CONTROL
    // ------------------

    function pause() external onlyGuardian whenNotPaused {
        paused = true;
        emit Paused();
    }

    function resume() external onlyGuardian {
        require(paused, "not paused");
        paused = false;
        emit Resumed();
    }

    // ------------------
    // VIEW
    // ------------------

    function getProposal(bytes32 id) external view returns (Proposal memory) {
        return _proposals[id];
    }

    function owners() external view returns (address[] memory) {
        return ownerList;
    }

    // ------------------
    // INTERNAL GOVERNANCE EXEC
    // ------------------

    function _executeGovernance(bytes memory encoded) internal returns (bool, bytes memory) {
        uint8 kind = uint8(encoded[0]);
        bytes memory arg;
        unchecked {
            arg = new bytes(encoded.length - 1);
            for (uint i = 1; i < encoded.length; i++) arg[i - 1] = encoded[i];
        }

        if (kind == 0x01) {
            address a = abi.decode(arg, (address));
            _addOwner(a);
            return (true, "");
        } else if (kind == 0x02) {
            address a = abi.decode(arg, (address));
            _removeOwner(a);
            return (true, "");
        } else if (kind == 0x03) {
            uint256 t = abi.decode(arg, (uint256));
            _setThreshold(t);
            return (true, "");
        } else if (kind == 0x04) {
            uint256 d = abi.decode(arg, (uint256));
            _setMinDelayGlobal(d);
            return (true, "");
        } else if (kind == 0x05) {
            address g = abi.decode(arg, (address));
            _setGuardian(g);
            return (true, "");
        } else {
            revert("bad kind");
        }
    }

    function _addOwner(address a) internal {
        require(a != address(0), "zero");
        require(!isOwner[a], "exists");
        isOwner[a] = true;
        ownerList.push(a);
        emit OwnerAdded(a);
        require(threshold <= ownerList.length, "th>n");
    }

    function _removeOwner(address a) internal {
        require(isOwner[a], "no owner");
        isOwner[a] = false;

        uint len = ownerList.length;
        for (uint i = 0; i < len; i++) {
            if (ownerList[i] == a) {
                ownerList[i] = ownerList[len - 1];
                ownerList.pop();
                break;
            }
        }

        emit OwnerRemoved(a);
        require(threshold > 0 && threshold <= ownerList.length, "bad th");
    }

    function _setThreshold(uint256 t) internal {
        require(t > 0 && t <= ownerList.length, "bad th");
        threshold = t;
        emit ThresholdChanged(t);
    }

    function _setMinDelayGlobal(uint256 d) internal {
        minDelayGlobal = d;
        emit MinDelayChanged(d);
    }

    function _setGuardian(address g) internal {
        guardian = g;
        emit GuardianChanged(g);
    }

    receive() external payable {}
}
