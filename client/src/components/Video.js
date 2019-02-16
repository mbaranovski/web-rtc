import React from 'react';

export const Video = React.forwardRef(({id, muted}, ref) => <video ref={ref} id={id} autoPlay muted={muted}></video>)
