<script>
	export let onClickFunc = () => {};
    export let initValue = true;
    let value = initValue;
</script>

<div
	class="switch"
	class:checked={value}
	on:click={(e) => {
        value = !value;
        onClickFunc(value)
    }}
>
	<div class="thumb">
        <div class="text">{value ? 'Yes' : 'No'}</div>
    </div>
</div>

<style>
	.switch {
		display: inline-block;
		position: relative;
		width: 60px;
		height: 31px;
		border-radius: 12px;
		background-color: #ccc;
		cursor: pointer;
		transition: background-color 0.3s;
	}

	.switch.checked {
		background-color: #4CAF50;
	}

	.thumb {
		position: absolute;
		top: 2px;
		left: 2px;
		width: 35px;
		height: 26px;
		background-color: white;
		border-radius: 12px;
		transition: transform 0.3s;
        display: flex;
        justify-content: center;
        align-items: center;
	}

	.switch.checked .thumb {
		transform: translateX(21px);
	}

    .text {
        font-size: 14px;
        font-weight: bold;
        color: #333;
    }
</style>
