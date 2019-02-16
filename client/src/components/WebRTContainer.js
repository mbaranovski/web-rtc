import React from 'react';
import socketIOClient from "socket.io-client";
import {Video} from "./Video";

export default class WebRTContainer extends React.Component {

    localVideo = new React.createRef();
    remoteVideo = new React.createRef();
    pcConfig = {
        'iceServers': [{
            'urls': 'stun:stun.l.google.com:19302'
        }]
    };

    state = {
        isInitiator: false,
        isChannelReady: false,
        isStarted: false,
        socket: null,
        constraints: {
            video: true
        },
        localStream: null,
        remoteStream: null,
        turnReady: null,
        pc: null
    };

    async componentDidMount() {
        this.setState({socket: socketIOClient("http://127.0.0.1:8081")}, async () => {
            this.addSocketIOListeners();
        });

        const mediaStream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: true
        })
            .catch(function (e) {
                alert('getUserMedia() error: ' + e.name);
            });

        this.gotStream(mediaStream);

        console.log('Getting user media with constraints', this.state.constraints);

        if (window.location.hostname !== 'localhost') {
            await this.requestTurn(
                'https://computeengineondemand.appspot.com/turn?username=41784574&key=4080218913'
            );
        }

        window.onbeforeunload = () => {
            this.sendMessage('bye');
        };
    }

    addSocketIOListeners = () => {
        const {room} = this.props;

        if (room !== '') {
            this.state.socket.emit('create or join', room);
            console.log('Attempted to create or  join room', room);
        }

        this.state.socket.on('created', (room) => {
            console.log('Created room ' + room);
            this.setState({isInitiator: true});
        });

        this.state.socket.on('full', (room) => {
            console.log('Room ' + room + ' is full');
        });

        this.state.socket.on('join', (room) => {
            console.log('Another peer made a request to join room ' + room);
            console.log('This peer is the initiator of room ' + room + '!');
            this.setState({isChannelReady: true});
        });

        this.state.socket.on('joined', (room) => {
            console.log('joined: ' + room);
            this.setState({isChannelReady: true});
        });

        this.state.socket.on('log', (array) => {
            console.log.apply(console, array);
        });

        this.state.socket.on('message', async (message) => {
            console.log('Client received message:', message);
            if (message === 'got user media') {
                await this.maybeStart();
            } else if (message.type === 'offer') {
                if (!this.state.isInitiator && !this.state.isStarted) {
                    await this.maybeStart();
                }
                await this.state.pc.setRemoteDescription(new RTCSessionDescription(message));
                this.doAnswer();
            } else if (message.type === 'answer' && this.isStarted) {
                await this.state.pc.setRemoteDescription(new RTCSessionDescription(message));
            } else if (message.type === 'candidate' && this.isStarted) {
                const candidate = new RTCIceCandidate({
                    sdpMLineIndex: message.label,
                    candidate: message.candidate
                });
                await this.pc.addIceCandidate(candidate);
            } else if (message === 'bye' && this.isStarted) {
                this.handleRemoteHangup();
            }
        });
    }

    gotStream = async (stream) => {
        console.log('Adding local stream.');
        this.setState({localStream: stream});
        console.log("MICHAL: this.localVideo", this.localVideo);
        this.localVideo.current.srcObject = stream;
        this.sendMessage('got user media');
        if (this.state.isInitiator) {
            await this.maybeStart();
        }
    };

    maybeStart = async () => {
        const {isStarted, isChannelReady, localStream, isInitiator} = this.state;
        console.log('>>>>>>> maybeStart() ', isStarted, localStream, isChannelReady);
        if (!isStarted && typeof localStream !== 'undefined' && isChannelReady) {
            console.log('>>>>>> creating peer connection');
            const pc = await this.createPeerConnection();
            pc.addStream(localStream);
            this.setState({isStarted: true});
            console.log('isInitiator', isInitiator);
            if (isInitiator) {
                this.doCall();
            }
        }
    }

    sendMessage = (message) => {
        console.log('Client sending message: ', message);
        this.state.socket.emit('message', message);
    }

    createPeerConnection = async () => new Promise((resolve, reject) => {
        try {
            const pc = new RTCPeerConnection(null);
            pc.onicecandidate = this.handleIceCandidate;
            pc.onaddstream = this.handleRemoteStreamAdded;
            pc.onremovestream = this.handleRemoteStreamRemoved;

            this.setState({pc}, () => resolve(pc));
            console.log('Created RTCPeerConnnection');
        } catch (e) {
            console.log('Failed to create PeerConnection, exception: ' + e.message);
            alert('Cannot create RTCPeerConnection object.');
            reject(e);
        }
    });

    handleIceCandidate = (event) => {
        console.log('icecandidate event: ', event);
        if (event.candidate) {
            this.sendMessage({
                type: 'candidate',
                label: event.candidate.sdpMLineIndex,
                id: event.candidate.sdpMid,
                candidate: event.candidate.candidate
            });
        } else {
            console.log('End of candidates.');
        }
    };
    handleCreateOfferError = (event) => {
        console.log('createOffer() error: ', event);
    }

    doCall = () => {
        console.log('Sending offer to peer');
        return this.state.pc.createOffer(this.setLocalAndSendMessage, this.handleCreateOfferError);
    }

    doAnswer = () => {
        console.log('Sending answer to peer.');
        this.state.pc.createAnswer().then(
            this.setLocalAndSendMessage,
            this.onCreateSessionDescriptionError
        );
    }

    setLocalAndSendMessage = async (sessionDescription) => {
        await this.state.pc.setLocalDescription(sessionDescription);
        console.log('setLocalAndSendMessage sending message', sessionDescription);
        this.sendMessage(sessionDescription);
    }

    onCreateSessionDescriptionError = (error) => {
        console.log('Failed to create session description: ' + error.toString());
    }

    requestTurn = (turnURL) => {
        return new Promise(resolve => {
            let turnExists = false;
            for (let i in this.pcConfig.iceServers) {
                if (this.pcConfig.iceServers[i].urls.substr(0, 5) === 'turn:') {
                    turnExists = true;
                    this.setState({turnReady: false});
                    break;
                }
            }
            if (!turnExists) {
                console.log('Getting TURN server from ', turnURL);
                // No TURN server. Get one from computeengineondemand.appspot.com:
                const xhr = new XMLHttpRequest();
                xhr.onreadystatechange = () => {
                    if (xhr.readyState === 4 && xhr.status === 200) {
                        const turnServer = JSON.parse(xhr.responseText);
                        console.log('Got TURN server: ', turnServer);
                        this.pcConfig.iceServers.push({
                            'urls': 'turn:' + turnServer.username + '@' + turnServer.turn,
                            'credential': turnServer.password
                        });
                        this.setState({turnReady: true});
                        resolve(true);
                    }
                };
                xhr.open('GET', turnURL, true);
                xhr.send();
            }
        })
    };

    handleRemoteStreamAdded = (event) => {
        const stream = event.stream;
        console.log('Remote stream added.', stream);
        this.remoteVideo.current.srcObject = stream;
        this.setState({remoteStream: stream})
    };

    handleRemoteStreamRemoved = (event) => {
        console.log('Remote stream removed. Event: ', event);
    };

    hangup = () => {
        console.log('Hanging up.');
        this.stop();
        this.sendMessage('bye');
    };

    handleRemoteHangup = () => {
        console.log('Session terminated.');
        this.stop();
        this.setState({isInitiator: false});
    };

    stop = () => {
        this.state.pc.close();
        this.setState({pc: null, isStarted: false});
    };

    render() {
        return <div id="videos">
            <Video ref={this.localVideo} id={"localVideo"} muted={true}></Video>
            <Video ref={this.remoteVideo} id={"remoteVideo"} muted={false}></Video>
        </div>
    }

}
